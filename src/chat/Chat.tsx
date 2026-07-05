import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DisplayMessage } from './types'

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
  onToggleDebug: () => void
  onOpenSettings: () => void
  onSave: () => void
  onLoad: () => void
}

type RenderItem =
  | { type: 'msg'; m: DisplayMessage }
  | { type: 'sysgroup'; id: string; notes: DisplayMessage[] }

/**
 * Fold each maximal run of consecutive `system` notes (tool progress: Read/Grep/工具完成/✓ 完成…)
 * into one group — mirroring the Claude Code VSCode extension, which collapses tool activity into a
 * single expandable row. A real reply (assistant/user/debug) breaks the run, so notes only collapse
 * when there's no actual reply between them.
 */
/** An error note (the send catch's `出错：…`) — must stay visible, never folded away. */
const isErrorNote = (m: DisplayMessage) => m.text.startsWith('出错')

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
  onToggleDebug,
  onOpenSettings,
  onSave,
  onLoad,
}: ChatProps) {
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
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

  const send = () => {
    const t = text.trim()
    if (!t || busy) return
    onSend(t)
    setText('')
  }

  return (
    <div className="chat">
      <header className="chat-bar">
        <strong>FlowM</strong>
        {engines.length > 1 && (
          <select
            value={engineId}
            onChange={(e) => onSelectEngine(e.target.value)}
            title="选择引擎：画布助手 / 本地 agent"
            style={{ marginLeft: 8 }}
          >
            {engines.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <button onClick={onSave} title="保存工程">保存</button>
        <button onClick={onLoad} title="加载工程">加载</button>
        <button
          onClick={onToggleDebug}
          title="调试模式：显示每次发送给模型的请求"
          aria-pressed={debug}
        >
          {debug ? 'Debug ✓' : 'Debug'}
        </button>
        <button onClick={onOpenSettings} title="设置（API 与本地 agent）">
          ⚙
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
            在画布上放置或手绘图形，选中后在这里向大模型描述需求；模型可直接修改画布。
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
                  {m.text}
                </div>
              )
            }
            const summary = it.notes[it.notes.length - 1].text
            return (
              <details key={it.id} className="msg msg-sysgroup">
                <summary>
                  <span className="sysgroup-count">{it.notes.length} 步</span>
                  <span className="sysgroup-summary">{summary}</span>
                </summary>
                <div className="sysgroup-body">
                  {/* The last note is already the (always-visible) summary — don't show it twice. */}
                  {it.notes.slice(0, -1).map((n) => (
                    <div key={n.id} className="sysgroup-note">
                      {n.text}
                    </div>
                  ))}
                </div>
              </details>
            )
          }
          const m = it.m
          if (m.role === 'debug') {
            return (
              <details key={m.id} className="msg msg-debug">
                <summary>发送给模型的请求{m.image ? '（含图片）' : ''}</summary>
                <pre>{m.text}</pre>
                {m.image && <img className="debug-image" src={m.image} alt="发送给模型的画布缩略图" />}
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
              {m.text}
            </div>
          )
        })}
      </div>

      <div className="chat-input">
        <textarea
          value={text}
          placeholder={placeholder}
          disabled={!canSend || busy}
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
        <button onClick={send} disabled={!canSend || busy || !text.trim()}>
          {busy ? '…' : '发送'}
        </button>
      </div>
    </div>
  )
}
