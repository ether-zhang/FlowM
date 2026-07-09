import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DisplayMessage, QuestionChoice } from './types'
import { engineDisplayLabel, formatUiText, isSystemErrorNote, localizeSystemNote, type UiText } from '../app/uiText'

export interface ChatProps {
  messages: DisplayMessage[]
  busy: boolean
  /** Whether the selected engine can send right now (key set / dir filled). */
  canSend: boolean
  debug: boolean
  /** Engines to choose between; the selector hides itself when there's only one. */
  engines: { id: string; label: string }[]
  engineId: string
  onSelectEngine: (id: string) => void
  /** Engine-specific config row (e.g. a cwd input), owned by the caller. */
  engineConfig?: React.ReactNode
  placeholder: string
  onSend: (text: string) => void
  onAnswerQuestion: (messageId: string, choice: QuestionChoice, text?: string) => void
  onToggleDebug: () => void
  onOpenSettings: () => void
  onSave: () => void
  onLoad: () => void
  text: UiText
}

type RenderItem =
  | { type: 'msg'; m: DisplayMessage }
  | { type: 'sysgroup'; id: string; notes: DisplayMessage[] }

/**
 * Fold each maximal run of consecutive `system` notes (tool progress: Read/Grep/tool done/result…)
 * into one group — mirroring the Claude Code VSCode extension, which collapses tool activity into a
 * single expandable row. A real reply (assistant/user/debug) breaks the run, so notes only collapse
 * when there's no actual reply between them.
 */
/** Error notes must stay visible, never folded away. */
const isErrorNote = (m: DisplayMessage) => isSystemErrorNote(m.text)

function groupMessages(messages: DisplayMessage[]): RenderItem[] {
  const items: RenderItem[] = []
  for (const m of messages) {
    // Errors break the run and render standalone: folded into the collapsed success-styled
    // progress group they'd read as normal completed activity (and hide behind its summary).
    if (m.role === 'system' && !isErrorNote(m)) {
      const last = items[items.length - 1]
      if (last && last.type === 'sysgroup') last.notes.push(m)
      else items.push({ type: 'sysgroup', id: m.id, notes: [m] })
    } else {
      items.push({ type: 'msg', m })
    }
  }
  return items
}

export function Chat({
  messages,
  busy,
  canSend,
  debug,
  engines,
  engineId,
  onSelectEngine,
  engineConfig,
  placeholder,
  onSend,
  onAnswerQuestion,
  onToggleDebug,
  onOpenSettings,
  onSave,
  onLoad,
  text: uiText,
}: ChatProps) {
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const engineMenuRef = useRef<HTMLDivElement>(null)
  const [engineMenuOpen, setEngineMenuOpen] = useState(false)
  const [otherQuestionId, setOtherQuestionId] = useState<string | null>(null)
  const [otherText, setOtherText] = useState('')
  // IME (CJK) guards for Enter-to-send. No single signal is reliable across webviews, so onKeyDown
  // combines them. `composingRef` is true between compositionstart and compositionend.
  const composingRef = useRef(false)
  // The macOS WebKit / WKWebView (Tauri) case (bug 165004): it fires `compositionend` BEFORE the
  // keydown of the Enter that commits a candidate, and at that keydown isComposing=false, keyCode≠229
  // and composingRef is already cleared — indistinguishable from a real Enter by any signal. So we ARM
  // on compositionend and DISARM on the committing key's keyup: the commit keydown falls inside that
  // window (compositionend → keydown → keyup) and is suppressed, while a SEPARATE later Enter (a real
  // send, which can only arrive after that keyup) is not. This survives the reversed event order AND a
  // fast confirm-then-send double-tap — where a pure time cooldown would wrongly eat the send.
  const imeCommitArmedRef = useRef(false)
  // Backstop only: if the committing key's keyup never reaches us (mouse candidate pick, or WebKit
  // swallowing it) the armed flag would linger and eat one later Enter. Expire it after a window far
  // longer than the ~ms compositionend→keydown gap yet shorter than a hand moving mouse→keyboard.
  const compositionEndAtRef = useRef(0)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  useEffect(() => {
    if (!engineMenuOpen) return
    const closeOnOutside = (e: PointerEvent) => {
      if (!engineMenuRef.current?.contains(e.target as Node)) setEngineMenuOpen(false)
    }
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEngineMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [engineMenuOpen])

  const pendingQuestion = messages.find((m) => m.question && !m.question.answer)

  const send = () => {
    const t = text.trim()
    if (!t || busy || pendingQuestion) return
    onSend(t)
    setText('')
  }

  const activeEngine = engines.find((e) => e.id === engineId) ?? engines[0]
  const activeEngineLabel = activeEngine ? engineDisplayLabel(uiText, activeEngine.id, activeEngine.label) : uiText.chat.assistant
  const questionChoiceLabel = (choice: QuestionChoice) =>
    choice === 'yes' ? uiText.chat.questionYes : choice === 'no' ? uiText.chat.questionNo : uiText.chat.questionOther
  const submitQuestionAnswer = (messageId: string, choice: QuestionChoice, value = '') => {
    const answer = value.trim()
    if (choice === 'other' && !answer) return
    onAnswerQuestion(messageId, choice, answer)
    if (otherQuestionId === messageId) {
      setOtherQuestionId(null)
      setOtherText('')
    }
  }

  return (
    <div className="chat">
      <header className="chat-bar">
        <strong>FlowM</strong>
        {engines.length > 1 && (
          <div className="engine-menu" ref={engineMenuRef}>
            <button
              type="button"
              className="chat-engine-select"
              aria-haspopup="listbox"
              aria-expanded={engineMenuOpen}
              title={uiText.chat.selectAssistant}
              onClick={() => setEngineMenuOpen((open) => !open)}
            >
              <span>{activeEngineLabel}</span>
              <span className="engine-chevron" aria-hidden="true" />
            </button>
            {engineMenuOpen && (
              <div className="engine-menu-list" role="listbox" aria-label={uiText.chat.selectAssistant}>
                {engines.map((e) => {
                  const label = engineDisplayLabel(uiText, e.id, e.label)
                  return (
                    <button
                      key={e.id}
                      type="button"
                      role="option"
                      aria-selected={e.id === engineId}
                      className={`engine-option${e.id === engineId ? ' active' : ''}`}
                      onClick={() => {
                        onSelectEngine(e.id)
                        setEngineMenuOpen(false)
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
        <span className="spacer" />
        <button hidden onClick={onSave} title={uiText.chat.saveProject}>{uiText.chat.saveProject}</button>
        <button hidden onClick={onLoad} title={uiText.chat.loadProject}>{uiText.chat.loadProject}</button>
        <button
          hidden
          onClick={onToggleDebug}
          title={uiText.chat.debugRequest}
          aria-pressed={debug}
        >
          {debug ? 'Debug ✓' : 'Debug'}
        </button>
        <button
          className="chat-settings-btn"
          onClick={onOpenSettings}
          title={uiText.chat.settingsTitle}
          aria-label={uiText.chat.settings}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
            <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.1 1.66V21a2 2 0 0 1-4 0v-.09a1.8 1.8 0 0 0-1.1-1.66 1.8 1.8 0 0 0-1.98.36l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.8 1.8 0 0 0 4.6 15a1.8 1.8 0 0 0-1.66-1.1H2.85a2 2 0 0 1 0-4h.09A1.8 1.8 0 0 0 4.6 8.8a1.8 1.8 0 0 0-.36-1.98l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.8 1.8 0 0 0 1.98.36 1.8 1.8 0 0 0 1.1-1.66V2.6a2 2 0 0 1 4 0v.09a1.8 1.8 0 0 0 1.1 1.66 1.8 1.8 0 0 0 1.98-.36l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.66 1.1h.09a2 2 0 0 1 0 4h-.09A1.8 1.8 0 0 0 19.4 15Z" />
          </svg>
        </button>
      </header>

      {engineConfig && (
        <div className="chat-engine-config" style={{ padding: '4px 8px', borderBottom: '1px solid #eee' }}>
          {engineConfig}
        </div>
      )}

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <p className="chat-hint">
            {uiText.chat.hint}
          </p>
        )}
        {groupMessages(messages).map((it) => {
          if (it.type === 'sysgroup') {
            // A single note renders as one plain system line; a run collapses into one expandable
            // group whose summary tracks the latest note (the ✓ 完成 line once it lands).
            if (it.notes.length === 1) {
              const m = it.notes[0]
              return (
                <div key={m.id} className="msg msg-system">
                  {localizeSystemNote(uiText, m.text)}
                </div>
              )
            }
            const summary = localizeSystemNote(uiText, it.notes[it.notes.length - 1].text)
            return (
              <details key={it.id} className="msg msg-sysgroup">
                <summary>
                  <span className="sysgroup-count">{it.notes.length} {uiText.chat.steps}</span>
                  <span className="sysgroup-summary">{summary}</span>
                </summary>
                <div className="sysgroup-body">
                  {/* The last note is already the (always-visible) summary — don't show it twice. */}
                  {it.notes.slice(0, -1).map((n) => (
                    <div key={n.id} className="sysgroup-note">
                      {localizeSystemNote(uiText, n.text)}
                    </div>
                  ))}
                </div>
              </details>
            )
          }
          const m = it.m
          if (m.question) {
            const q = m.question
            const answered = q.answer
            const otherOpen = otherQuestionId === m.id
            const answerText = answered
              ? answered.text || questionChoiceLabel(answered.choice)
              : ''
            return (
              <div key={m.id} className={`msg msg-question${answered ? ' answered' : ''}`}>
                <div className="question-kicker">{uiText.chat.questionTitle}</div>
                {m.text && (
                  <div className="question-context">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                  </div>
                )}
                <div className="question-prompt">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{q.prompt}</ReactMarkdown>
                </div>
                {answered ? (
                  <div className="question-answer">
                    {formatUiText(uiText.chat.questionAnswered, { answer: answerText })}
                  </div>
                ) : (
                  <>
                    <div className="question-actions">
                      <button type="button" disabled={busy} onClick={() => submitQuestionAnswer(m.id, 'yes')}>
                        {uiText.chat.questionYes}
                      </button>
                      <button type="button" disabled={busy} onClick={() => submitQuestionAnswer(m.id, 'no')}>
                        {uiText.chat.questionNo}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setOtherQuestionId(otherOpen ? null : m.id)
                          setOtherText('')
                        }}
                      >
                        {uiText.chat.questionOther}
                      </button>
                    </div>
                    {otherOpen && (
                      <div className="question-other">
                        <textarea
                          value={otherText}
                          placeholder={uiText.chat.questionOtherPlaceholder}
                          disabled={busy}
                          onChange={(e) => setOtherText(e.target.value)}
                        />
                        <button
                          type="button"
                          disabled={busy || !otherText.trim()}
                          onClick={() => submitQuestionAnswer(m.id, 'other', otherText)}
                        >
                          {uiText.chat.questionSendOther}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          }
          if (m.role === 'debug') {
            return (
              <details key={m.id} className="msg msg-debug">
                <summary>{m.image ? uiText.chat.debugRequestWithImage : uiText.chat.debugRequest}</summary>
                <pre>{m.text}</pre>
                {m.image && <img className="debug-image" src={m.image} alt={uiText.chat.debugImageAlt} />}
              </details>
            )
          }
          if (m.role === 'assistant') {
            return (
              <div key={m.id} className="msg msg-assistant">
                {m.text ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                ) : busy ? (
                  '…'
                ) : null}
              </div>
            )
          }
          return (
            <div key={m.id} className={`msg msg-${m.role}${m.role === 'system' && isErrorNote(m) ? ' msg-error' : ''}`}>
              {m.role === 'system' ? localizeSystemNote(uiText, m.text) : m.text}
            </div>
          )
        })}
      </div>

      <div className="chat-input">
        <textarea
          value={text}
          placeholder={pendingQuestion ? uiText.chat.questionInputDisabled : placeholder}
          disabled={!canSend || busy || !!pendingQuestion}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true
            imeCommitArmedRef.current = false
          }}
          onCompositionEnd={() => {
            composingRef.current = false
            imeCommitArmedRef.current = true // WebKit's reversed order: the commit key's keydown is still to come
            compositionEndAtRef.current = performance.now()
          }}
          onKeyUp={() => {
            // The committing key was released — close the window so the NEXT Enter press (a genuine
            // send, which can only start after this keyup) is not mistaken for the commit.
            imeCommitArmedRef.current = false
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return // Shift+Enter = newline
            // Enter sends — but never the Enter that commits an IME candidate. No single signal is
            // reliable across webviews, so treat it as a commit if ANY holds:
            //   • isComposing        — Chrome/Windows + spec-fixed Safari
            //   • keyCode === 229    — IME-processed key (legacy Safari, where isComposing lies)
            //   • composingRef       — engines whose keydown precedes compositionend
            //   • armed window       — legacy macOS WebKit: compositionend fired and the commit key's
            //     keyup hasn't (so this keydown is between them). A real send comes after a keyup, so
            //     it isn't armed — unlike a time cooldown, this doesn't eat a fast confirm-then-send.
            // Never preventDefault a commit Enter — that would cancel the IME confirmation.
            const armed =
              imeCommitArmedRef.current && performance.now() - compositionEndAtRef.current < 200
            if (e.nativeEvent.isComposing || e.keyCode === 229 || composingRef.current || armed) return
            e.preventDefault()
            send()
          }}
        />
        <button onClick={send} disabled={!canSend || busy || !!pendingQuestion || !text.trim()}>
          {busy ? '…' : uiText.chat.send}
        </button>
      </div>
    </div>
  )
}
