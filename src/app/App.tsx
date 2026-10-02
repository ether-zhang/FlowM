import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Canvas, createExcalidrawPort } from '../canvas'
import type { CanvasPort } from '../protocol'
import type { LlmMessage, LlmQuestion } from '../llm'
import { Chat, createDisplayActivity, reduceActivity, type DisplayMessage, type DisplayQuestion } from '../chat'
import { FilePanel, FloatingEditor, GitPanel, PickerBar, useWorkspace } from '../workspace'
import { Resizer } from './Resizer'
import { ModelPicker } from './ModelPicker'
import { useHarnessConnection } from './useHarnessConnection'
import { HarnessSettings } from './HarnessSettings'
import { resolveEngineId } from './engineSelection'
import { buildProject, downloadProject, openProjectFile, restoreCanvas } from '../persistence'
import { CanvasEngine, type ChatEngine } from '../engine'
import { HarnessProjectEngine } from '../engine/harnessProjectEngine'
import { ActivityBar, isActivityView, type ActivityView } from './ActivityBar'
import { formatUiText, parseUiLanguage, UI_LANGUAGE_STORAGE, uiLanguageOptions, uiText, type UiLanguage } from './uiText'
import './app.css'

// Persisted across restarts so heavy iteration doesn't mean re-picking the engine / re-typing the path.
const ENGINE_STORAGE = 'flowm.engine'
// Shell pane geometry (files left / chat right), persisted so the layout survives restarts.
const FILES_W_STORAGE = 'flowm.filesW'
const CHAT_W_STORAGE = 'flowm.chatW'
const FILES_SHOWN_STORAGE = 'flowm.filesShown'
const ACTIVITY_VIEW_STORAGE = 'flowm.activityView'

const numFromStorage = (k: string, fallback: number) => {
  const n = Number(localStorage.getItem(k))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function App() {
  const portRef = useRef<CanvasPort | null>(null)
  // Preserve an imported file's legacy history for export, without using its old transport.
  const importedHistoryRef = useRef<{ display: DisplayMessage[]; api: LlmMessage[] } | null>(null)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const activeEngineRef = useRef<ChatEngine | null>(null)
  const [debug, setDebug] = useState(false)
  const [language, setLanguageState] = useState<UiLanguage>(() => parseUiLanguage(localStorage.getItem(UI_LANGUAGE_STORAGE)))
  const text = uiText[language]
  const setLanguage = (next: UiLanguage) => {
    setLanguageState(next)
    localStorage.setItem(UI_LANGUAGE_STORAGE, next)
  }
  // Settings presents one active model connection managed by the native harness.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // A small confirm dialog for destructive actions (delete session / canvas). Rename is inline in
  // the picker (double-click), so it needs no dialog. `onOk` runs on 删除.
  const [dialog, setDialog] = useState<{ title: string; message: string; onOk: () => void } | null>(null)
  const openConfirm = useCallback((title: string, message: string, onOk: () => void) => {
    setDialog({ title, message, onOk })
  }, [])

  // Harness roles use the folder selected by Open Project, rather than a restored shell path.
  const cwdRef = useRef('')
  const [cwd, setCwd] = useState('')
  const connections = useHarnessConnection()

  // Shell pane geometry. Panels are data-driven (side + width + shown) so a future VSCode-style
  // rearrange only changes this state, not the render — the seam is here. Defaults keep the centre
  // canvas wide enough (>~730px on a normal window) that Excalidraw stays in desktop, not mobile, UI.
  const [filesW, setFilesW] = useState(() => numFromStorage(FILES_W_STORAGE, 240))
  const [chatW, setChatW] = useState(() => numFromStorage(CHAT_W_STORAGE, 340))
  const [filesShown, setFilesShown] = useState(() => localStorage.getItem(FILES_SHOWN_STORAGE) !== '0')
  const [activeActivity, setActiveActivity] = useState<ActivityView>(() => {
    const saved = localStorage.getItem(ACTIVITY_VIEW_STORAGE)
    return isActivityView(saved) ? saved : 'files'
  })
  // The file currently open in the floating editor (absolute path), or null.
  const [openFile, setOpenFile] = useState<string | null>(null)

  const persistFilesW = (w: number) => {
    setFilesW(w)
    localStorage.setItem(FILES_W_STORAGE, String(w))
  }
  const persistChatW = (w: number) => {
    setChatW(w)
    localStorage.setItem(CHAT_W_STORAGE, String(w))
  }
  const toggleFiles = (shown: boolean) => {
    setFilesShown(shown)
    localStorage.setItem(FILES_SHOWN_STORAGE, shown ? '1' : '0')
  }
  const selectActivity = (view: ActivityView) => {
    setActiveActivity(view)
    localStorage.setItem(ACTIVITY_VIEW_STORAGE, view)
    toggleFiles(activeActivity === view ? !filesShown : true)
  }

  // A live mirror of `messages` so the workspace's async save/switch reads the latest bubbles
  // (a state closure would be stale). Kept in sync by the effect below.
  const messagesRef = useRef<DisplayMessage[]>([])

  const setFolder = useCallback((folder: string) => {
    cwdRef.current = folder
    setCwd(folder)
  }, [])

  // The project / multi-conversation layer owns local canvas-agent conversations. Without an open
  // project `ws.activeConv()` is null, so local agents cannot accidentally run outside a project.
  const ws = useWorkspace({
    getPort: () => portRef.current,
    getMessages: () => messagesRef.current,
    setMessages,
    getCwd: () => cwdRef.current,
    getConnection: connections.getConnection,
    isBusy: () => busyRef.current,
    setFolder,
  })

  const isWorkspaceChanging = ws.isChanging
  // Both roles use the packaged harness and read the active workspace through getters.
  // Constructors store getters and read them only during send/cancel, outside render.
  // eslint-disable-next-line react-hooks/refs
  const [engines] = useState<ChatEngine[]>(() => [
    new CanvasEngine(() => ws.activeConv(), () => portRef.current),
    new HarnessProjectEngine(() => ws.activeProject(), () => portRef.current),
  ])
  const [engineId, setEngineId] = useState(() => resolveEngineId(localStorage.getItem(ENGINE_STORAGE)))

  // Mirror `messages` for the workspace's async reads (declared FIRST so it updates before the
  // persist effect below reads it), then persist the active conversation whenever a send settles
  // or the active conversation changes.
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])
  const persistActiveRef = useRef(ws.persistActive)
  useEffect(() => { persistActiveRef.current = ws.persistActive }, [ws.persistActive])
  useEffect(() => {
    if (!busy && ws.activeSessionId) void persistActiveRef.current()
  }, [busy, ws.activeSessionId])

  const onReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      portRef.current = createExcalidrawPort(api)
    },
    [],
  )

  const addMessage = (role: DisplayMessage['role'], text: string, image?: string) => {
    const id = crypto.randomUUID()
    setMessages((m) => [...m, { id, role, text, image }])
    return id
  }

  const addQuestionMessage = (question: LlmQuestion, targetEngineId: string) => {
    const id = crypto.randomUUID()
    setMessages((m) => [
      ...m,
      {
        id,
        role: 'assistant',
        text: '',
        question: {
          requestId: question.requestId,
          items: question.items,
          engineId: targetEngineId,
        },
      },
    ])
    return id
  }

  const appendToMessage = (id: string, delta: string) =>
    setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, text: msg.text + delta } : msg)))

  const formatQuestionAnswer = useCallback((question: DisplayQuestion, answers: Record<string, string[]>) => {
    const items = question.items?.length
      ? question.items
      : question.prompt
        ? [{ id: 'question', prompt: question.prompt }]
        : []
    return items
      .flatMap((item) => {
        const values = answers[item.id]?.filter(Boolean) ?? []
        if (!values.length) return []
        return items.length === 1
          ? [values.join(', ')]
          : [`${item.header || item.prompt}: ${values.join(', ')}`]
      })
      .join('\n')
  }, [])

  const sendToEngine = useCallback(
    async (targetEngineId: string, text: string) => {
      if (busyRef.current || isWorkspaceChanging()) return
      const engine = engines.find((e) => e.id === targetEngineId)
      if (!engine) return
      addMessage('user', text)
      busyRef.current = true
      activeEngineRef.current = engine
      setBusy(true)
      // Lazily open an assistant bubble on the first text; a system note closes it so the next
      // text starts a fresh bubble below — keeps Claude's "progress then prose" ordering readable.
      let assistantId: string | null = null
      let activityId: string | null = null
      try {
        await engine.send(text, {
          onText: (delta) => {
            if (!assistantId) assistantId = addMessage('assistant', '')
            appendToMessage(assistantId, delta)
          },
          onQuestion: (question) => {
            addQuestionMessage(question, targetEngineId)
            assistantId = null
          },
          onActivity: (event) => {
            if (!activityId) {
              activityId = crypto.randomUUID()
              const id = activityId
              setMessages((items) => [...items, {
                id,
                role: 'system',
                text: '',
                activity: reduceActivity(createDisplayActivity(), event),
              }])
              return
            }
            const id = activityId
            setMessages((items) => items.map((message) =>
              message.id === id && message.activity
                ? { ...message, activity: reduceActivity(message.activity, event) }
                : message,
            ))
          },
          onDebug: debug ? (t) => addMessage('debug', t) : undefined,
        })
      } catch (e) {
        if (activityId) {
          const id = activityId
          setMessages((items) => items.map((message) =>
            message.id === id && message.activity
              ? { ...message, activity: reduceActivity(message.activity, { type: 'status', status: 'failed' }) }
              : message,
          ))
        }
        // Not every throw is an Error: a Tauri command rejects with its Rust Err string, which
        // has no `.message` (it showed as "undefined"). Surface whatever it actually is.
        const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e)
        addMessage('system', `出错：${msg || '(空错误)'}`)
      } finally {
        setMessages((items) => items.map((message) => message.question?.requestId && !message.question.answer ? { ...message, question: { ...message.question, expired: true } } : message))
        activeEngineRef.current = null
        busyRef.current = false
        setBusy(false)
      }
    },
    [engines, debug, isWorkspaceChanging],
  )

  const onSend = useCallback(
    async (text: string) => {
      await sendToEngine(engineId, text)
    },
    [engineId, sendToEngine],
  )

  const onAnswerQuestion = useCallback(
    async (messageId: string, answers: Record<string, string[]>) => {
      const message = messagesRef.current.find((m) => m.id === messageId)
      const question = message?.question
      if (!question || question.answer || question.expired) return
      const answerText = formatQuestionAnswer(question, answers)
      if (!answerText.trim()) return
      const targetEngineId = resolveEngineId(question.engineId)
      const engine = question.requestId ? activeEngineRef.current : engines.find((item) => item.id === targetEngineId)
      if (!engine) return
      setMessages((items) =>
        items.map((m) =>
          m.id === messageId && m.question
            ? { ...m, question: { ...m.question, answer: { text: answerText } } }
            : m,
        ),
      )
      try {
        if (question.requestId) {
          if (!engine.answerQuestion) throw new Error('This agent cannot resume an in-flight question')
          await engine.answerQuestion({ requestId: question.requestId, answers })
        } else {
          if (busy) throw new Error('Wait for the current request to finish before answering')
          await sendToEngine(targetEngineId, answerText)
        }
      } catch (error) {
        setMessages((items) =>
          items.map((m) =>
            m.id === messageId && m.question
              ? { ...m, question: { ...m.question, answer: undefined } }
              : m,
          ),
        )
        const detail = error instanceof Error ? error.message : String(error)
        addMessage('system', `出错：${detail}`)
      }
    },
    [busy, engines, formatQuestionAnswer, sendToEngine],
  )

  const onSave = useCallback(() => {
    const port = portRef.current
    if (!port) return
    const imported = importedHistoryRef.current
    const history = imported?.display === messages ? imported.api : ws.activeConv()?.messages ?? []
    downloadProject(buildProject(port, messages, history))
  }, [messages, ws])

  const onLoad = useCallback(async () => {
    if (busyRef.current || ws.isChanging()) return
    const port = portRef.current
    if (!port) return
    const project = await openProjectFile()
    if (!project || busyRef.current || ws.isChanging()) return
    // Start imported visible history in a fresh harness session, retaining the previous session.
    if (ws.projectName) await ws.newSession()
    restoreCanvas(port, project)
    const display = project.display.map((message) => message.question && !message.question.answer ? { ...message, question: { ...message.question, expired: true } } : message)
    importedHistoryRef.current = { display, api: project.api }
    messagesRef.current = display
    setMessages(display)
    await ws.persistActive()
  }, [ws])

  const canSend = !ws.changing && !!cwd.trim() && !!connections.connection
  const placeholder = canSend
    ? text.app.placeholderReady
    : cwd.trim() ? text.harness.configureFirst : text.app.openProjectFirst
  const engineConfig = (
      <>
      <PickerBar
        disabled={busy || ws.changing}
        items={ws.sessions}
        activeId={ws.activeSessionId}
        placeholder={ws.projectName ? text.workspace.noSession : text.workspace.noProject}
        newTitle={text.workspace.newSession}
        onSelect={ws.selectSession}
        onNew={ws.newSession}
        onRename={(id, name) => ws.renameSession(id, name)}
        onDelete={(id, name) => openConfirm(text.workspace.deleteSessionTitle, formatUiText(text.workspace.deleteSessionMessage, { name }), () => ws.deleteSession(id))}
        text={text}
      />
      <div className="chat-model-connection" title={connections.profile?.account ?? ''}>
        <span className={`connection-status-dot${connections.profile ? ' online' : ''}`} />
        <span>{connections.profile ? connections.profile.kind === 'gateway' ? 'Gateway' : 'GPT' : text.harness.configureFirst}</span>
      </div>
      <ModelPicker
        key={`${connections.profile?.id ?? ''}:${engineId}`}
        value={connections.model}
        catalog={connections.catalog}
        onChange={connections.selectModel}
        disabled={busy || ws.changing || connections.loading || !connections.profile}
        loading={connections.loading}
        error={connections.catalogError}
        onRefresh={connections.refresh}
        text={text}
      />
      </>
    )
  const activeActivityLabel = text.activity.labels[activeActivity]

  return (
    <>
    {/* Shell: files left, canvas centre, chat right; pane visibility and widths are persisted. */}
    <div className="layout">
        <aside className="activity-shell">
          <ActivityBar active={activeActivity} panelOpen={filesShown} onSelect={selectActivity} text={text} />
          {filesShown && (
            <>
              {activeActivity === 'files' ? (
                <section className="side-pane file-pane-wrap" style={{ width: filesW }}>
                  <FilePanel folder={cwd} onOpenFile={setOpenFile} onOpenFolder={ws.openFolder} onHide={() => toggleFiles(false)} text={text} />
                </section>
              ) : activeActivity === 'git' ? (
                <section className="side-pane activity-pane" style={{ width: filesW }}>
                  <GitPanel folder={cwd} onHide={() => toggleFiles(false)} text={text} />
                </section>
              ) : (
                <section className="side-pane activity-pane" style={{ width: filesW }}>
                  <div className="activity-panel-head">
                    <span className="activity-panel-title">{activeActivityLabel}</span>
                    <button className="file-hide" onClick={() => toggleFiles(false)} title={text.app.hidePanel}>
                      «
                    </button>
                  </div>
                  <div className="activity-empty">{text.app.emptyPanel}</div>
                </section>
              )}
              <Resizer width={filesW} setWidth={persistFilesW} sign={1} />
            </>
          )}
        </aside>
      <main className="canvas-pane">
        <Canvas onReady={onReady} />
        {/* Canvas picker floats over the canvas top-right (below Excalidraw's Library button). Only
            when a project is open — canvases are a project concept, decoupled from sessions. */}
        {ws.activeCanvasId && (
          <div className="canvas-bar">
            <PickerBar
              disabled={busy || ws.changing}
              items={ws.canvases}
              activeId={ws.activeCanvasId}
              placeholder={text.workspace.noCanvas}
              newTitle={text.workspace.newCanvas}
              onSelect={ws.selectCanvas}
              onNew={ws.newCanvas}
              onRename={(id, name) => ws.renameCanvas(id, name)}
              onDelete={(id, name) => openConfirm(text.workspace.deleteCanvasTitle, formatUiText(text.workspace.deleteCanvasMessage, { name }), () => ws.deleteCanvas(id))}
              text={text}
            />
          </div>
        )}
      </main>
      <Resizer width={chatW} setWidth={persistChatW} sign={-1} />
      <aside className="side-pane chat-pane" style={{ width: chatW }}>
        <Chat
          messages={messages}
          busy={busy}
          canSend={canSend}
          debug={debug}
          engines={engines.map((e) => ({ id: e.id, label: e.label }))}
          engineId={engineId}
          onSelectEngine={(id) => {
            if (busyRef.current || ws.isChanging()) return
            setEngineId(resolveEngineId(id))
            localStorage.setItem(ENGINE_STORAGE, id)
          }}
          engineConfig={engineConfig}
          placeholder={placeholder}
          onSend={onSend}
          onStop={() => {
            void activeEngineRef.current?.cancel?.().catch((error) => addMessage('system', `出错：${error instanceof Error ? error.message : String(error)}`))
          }}
          onAnswerQuestion={onAnswerQuestion}
          onToggleDebug={() => setDebug((d) => !d)}
          onOpenSettings={() => setSettingsOpen(true)}
          onSave={onSave}
          onLoad={onLoad}
          text={text}
        />
      </aside>
    </div>

    {openFile && <FloatingEditor path={openFile} onClose={() => setOpenFile(null)} text={text} />}

    {dialog && (
      <div className="modal-backdrop" onClick={() => setDialog(null)}>
        {/* Escape closes from anywhere in the dialog (bubbles up from the focused control). */}
        <div
          className="modal"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setDialog(null)
          }}
        >
          <h3 className="modal-title">{dialog.title}</h3>
          <p className="modal-hint">{dialog.message}</p>
          <div className="modal-actions">
            {/* Focus lands on 取消: Enter right after opening cancels (never deletes), Escape
                closes — deleting always takes an explicit click / Tab+Enter. */}
            <button autoFocus onClick={() => setDialog(null)}>{text.common.cancel}</button>
            <button
              className="danger"
              onClick={() => {
                dialog.onOk()
                setDialog(null)
              }}
            >
              {text.common.delete}
            </button>
          </div>
        </div>
      </div>
    )}

    {settingsOpen && (
      <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
        <div className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="flowm-settings-title" onClick={(e) => e.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') setSettingsOpen(false) }}>
          <div className="settings-header"><h3 id="flowm-settings-title">{text.settings.title}</h3><button type="button" className="settings-close" aria-label={text.common.done} onClick={() => setSettingsOpen(false)}>×</button></div>
          <div className="settings-language-row"><label htmlFor="flowm-language">{text.language.label}</label>
          <select
            id="flowm-language"
            className="modal-input"
            value={language}
            onChange={(e) => setLanguage(parseUiLanguage(e.target.value))}
          >
            {uiLanguageOptions.map((id) => (
              <option key={id} value={id}>{text.language.options[id]}</option>
            ))}
          </select>
          </div>
            <HarnessSettings
              key={connections.profile?.id ?? 'disconnected'}
              profiles={connections.profiles}
              profile={connections.profile}
              disabled={busy || ws.changing || connections.loading}
              loginPending={connections.loginPending}
              onSave={connections.save}
              onLogin={connections.login}
              onLogout={connections.logout}
              onConnect={connections.connect}
              onCancelLogin={connections.cancelLogin}
              text={text}
            />
            {connections.error && <p className="settings-error" role="alert">{connections.error}</p>}
          <div className="modal-actions settings-footer">
            <button className="primary" onClick={() => setSettingsOpen(false)}>{text.common.done}</button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
