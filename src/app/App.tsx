import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Canvas, createExcalidrawPort } from '../canvas'
import type { CanvasPort } from '../protocol'
import { PoeAdapter, TauriAdapter, ClaudeAdapter, CodexAdapter, POE_BASE_URL, tauriKey, Conversation, type LlmQuestion, type RunTurnParams } from '../llm'
import { Chat, type DisplayMessage, type DisplayQuestion } from '../chat'
import { FilePanel, FloatingEditor, GitPanel, PickerBar, useWorkspace } from '../workspace'
import { Resizer } from './Resizer'
import { buildProject, downloadProject, openProjectFile, restoreCanvas } from '../persistence'
import { CanvasEngine, ClaudeEngine, CodexEngine, defaultClaudeBin, defaultCodexBin, type ChatEngine } from '../engine'
import { IS_TAURI } from '../runtime'
import { ActivityBar, isActivityView, type ActivityView } from './ActivityBar'
import { formatUiText, parseUiLanguage, UI_LANGUAGE_STORAGE, uiLanguageOptions, uiText, type UiLanguage } from './uiText'
import './app.css'

const KEY_STORAGE = 'flowm.apiKey'
const API_URL_STORAGE = 'flowm.apiUrl'
// Persisted across restarts so heavy iteration doesn't mean re-picking the engine / re-typing the path.
const BIN_STORAGE = 'flowm.bin'
const CODEX_BIN_STORAGE = 'flowm.codexBin'
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

const isVsCodeBundledCodex = (p: string) => /[\\/]\.vscode[\\/]extensions[\\/]openai\.chatgpt-/i.test(p)

/** Render one outgoing model request as readable text for the debug panel. */
function formatRequest(params: RunTurnParams, iteration: number): string {
  const lines = [`# 第 ${iteration + 1} 轮请求`, '', 'SYSTEM:', params.system, '', `MESSAGES (${params.messages.length}):`]
  for (const m of params.messages) {
    if (m.role === 'tool') {
      lines.push(`[tool ${m.toolCallId}] ${m.content}`)
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls?.length
        ? '\n  ↳ ' + m.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join('\n  ↳ ')
        : ''
      lines.push(`[assistant] ${m.content}${calls}`)
    } else {
      const img = m.role === 'user' && m.image ? ' [+image ↓]' : ''
      lines.push(`[${m.role}]${img} ${m.content}`)
    }
  }
  lines.push('', `TOOLS (${params.tools.length}): ${params.tools.map((t) => t.name).join(', ')}`)
  return lines.join('\n')
}

/** The image (if any) attached to the latest user message of a request. */
function requestImage(params: RunTurnParams): string | undefined {
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const m = params.messages[i]
    if (m.role === 'user') return m.image
  }
  return undefined
}

export function App() {
  const portRef = useRef<CanvasPort | null>(null)
  const convRef = useRef<Conversation | null>(null)

  // Browser: key lives in localStorage and is known synchronously.
  // Tauri: key lives in the Rust backend; resolve asynchronously below.
  const [apiKeySet, setApiKeySet] = useState(() =>
    IS_TAURI ? false : !!localStorage.getItem(KEY_STORAGE),
  )
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [debug, setDebug] = useState(false)
  const [language, setLanguageState] = useState<UiLanguage>(() => parseUiLanguage(localStorage.getItem(UI_LANGUAGE_STORAGE)))
  const text = uiText[language]
  const setLanguage = (next: UiLanguage) => {
    setLanguageState(next)
    localStorage.setItem(UI_LANGUAGE_STORAGE, next)
  }
  const initialApiUrl = localStorage.getItem(API_URL_STORAGE) ?? POE_BASE_URL
  const apiUrlRef = useRef(initialApiUrl)
  const [apiUrl, setApiUrl] = useState(initialApiUrl)
  // The saved API key is never prefilled; this field only holds a replacement typed in Settings.
  const [apiKeyInput, setApiKeyInput] = useState('')
  // Settings dialog holds API config and local agent executable paths.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // A small confirm dialog for destructive actions (delete session / canvas). Rename is inline in
  // the picker (double-click), so it needs no dialog. `onOk` runs on 删除.
  const [dialog, setDialog] = useState<{ title: string; message: string; onOk: () => void } | null>(null)
  const openConfirm = useCallback((title: string, message: string, onOk: () => void) => {
    setDialog({ title, message, onOk })
  }, [])

  // The working directory the local Claude Code engines run in (canvas·Claude + build). NOT restored
  // from localStorage: the folder now comes from 打开工程 in-session, so a fresh launch shows no files
  // until a project is opened (a persisted folder with no open project was confusing).
  const cwdRef = useRef('')
  const [cwd, setCwd] = useState('')
  // Path to the user's `claude` executable; prefilled from the backend's platform default (see the
  // effect below). A GUI Mac app doesn't inherit the shell PATH, so an absolute path is what lets
  // `claude` spawn; empty means "resolve `claude` via PATH".
  const binRef = useRef(localStorage.getItem(BIN_STORAGE) ?? '')
  const [bin, setBin] = useState(binRef.current)
  const codexBinRef = useRef(localStorage.getItem(CODEX_BIN_STORAGE) ?? '')
  const [codexBin, setCodexBin] = useState(codexBinRef.current)

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

  // A second Conversation driven by Claude Code (same pipeline, different LlmAdapter). Needs no
  // API key — Claude auth is the user's own `claude auth login`. Desktop only.
  const claudeConvRef = useRef<Conversation | null>(null)
  if (IS_TAURI && !claudeConvRef.current) {
    claudeConvRef.current = new Conversation(new ClaudeAdapter(() => cwdRef.current, () => binRef.current))
  }
  const codexConvRef = useRef<Conversation | null>(null)
  if (IS_TAURI && !codexConvRef.current) {
    codexConvRef.current = new Conversation(new CodexAdapter(() => cwdRef.current, () => codexBinRef.current))
  }

  // A live mirror of `messages` so the workspace's async save/switch reads the latest bubbles
  // (a state closure would be stale). Kept in sync by the effect below.
  const messagesRef = useRef<DisplayMessage[]>([])

  const setFolder = useCallback((folder: string) => {
    cwdRef.current = folder
    setCwd(folder)
  }, [])

  // The project / multi-conversation layer (desktop). Sits ABOVE the engines: when a project is
  // open, `ws.activeConv()` is the current conversation and the Claude canvas engine uses it; when
  // it's null (no project yet) the engine falls back to the legacy single conversation — so opening
  // a project is purely additive and the pre-project flow is untouched.
  const ws = useWorkspace({
    getPort: () => portRef.current,
    getMessages: () => messagesRef.current,
    setMessages,
    getCwd: () => cwdRef.current,
    getBin: () => binRef.current,
    getCodexBin: () => codexBinRef.current,
    setFolder,
  })

  // Selectable chat engines (decoupled behind ChatEngine). They read live conv/port/cwd via
  // getters, so they stay valid as those are recreated. On desktop: the API canvas assistant,
  // the SAME canvas assistant backed by Claude Code, and the build engine (画布 → 工程).
  const enginesRef = useRef<ChatEngine[] | null>(null)
  if (!enginesRef.current) {
    const poe = new CanvasEngine(() => convRef.current, () => portRef.current, {
      id: 'canvas',
      label: '画布助手·API',
    })
    enginesRef.current = IS_TAURI
      ? [
          poe,
          new CanvasEngine(() => ws.activeConv() ?? claudeConvRef.current, () => portRef.current, { id: 'canvas-claude', label: '画布助手·Claude', debugViaAdapter: true }),
          new CanvasEngine(() => ws.activeConv('codex') ?? codexConvRef.current, () => portRef.current, { id: 'canvas-codex', label: '画布助手·Codex', debugViaAdapter: true }),
          new ClaudeEngine(() => cwdRef.current, () => portRef.current, () => binRef.current), // 画布 → 工程 (build)
          new CodexEngine(() => cwdRef.current, () => portRef.current, () => codexBinRef.current),
        ]
      : [poe]
  }
  const engines = enginesRef.current
  const visibleEngines = engines.filter((e) => e.id !== 'claude' && e.id !== 'codex')
  const [engineId, setEngineId] = useState(() => {
    const saved = localStorage.getItem(ENGINE_STORAGE)
    return saved && visibleEngines.some((e) => e.id === saved) ? saved : 'canvas'
  })

  // Tauri's adapter keeps the API key in Rust; the browser adapter keeps it in localStorage.
  const ensureConversation = useCallback((key?: string) => {
    const adapter = IS_TAURI
      ? new TauriAdapter(() => apiUrlRef.current)
      : new PoeAdapter(key ?? '', () => apiUrlRef.current)
    const prev = convRef.current
    const conv = new Conversation(adapter)
    if (prev) conv.reset(prev.messages) // preserve history across key changes
    convRef.current = conv
    return conv
  }, [])

  // Under Tauri, ask the backend whether a key is stored, then wire the adapter.
  useEffect(() => {
    if (!IS_TAURI) return
    tauriKey.has().then((has) => {
      setApiKeySet(has)
      if (has && !convRef.current) ensureConversation()
    })
  }, [ensureConversation])

  // Prefill the `claude` executable path with the backend's platform default (the user can edit it).
  useEffect(() => {
    if (!IS_TAURI) return
    defaultClaudeBin().then((p) => {
      if (!binRef.current) {
        binRef.current = p
        setBin(p)
      }
    })
  }, [])
  useEffect(() => {
    if (!IS_TAURI) return
    defaultCodexBin().then((p) => {
      if (!codexBinRef.current || (isVsCodeBundledCodex(codexBinRef.current) && p !== codexBinRef.current)) {
        codexBinRef.current = p
        setCodexBin(p)
        localStorage.setItem(CODEX_BIN_STORAGE, p)
      }
    })
  }, [])

  // Mirror `messages` for the workspace's async reads (declared FIRST so it updates before the
  // persist effect below reads it), then persist the active conversation whenever a send settles
  // or the active conversation changes.
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])
  useEffect(() => {
    if (!busy && ws.activeSessionId) void ws.persistActive()
  }, [busy, ws.activeSessionId])

  const onReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      portRef.current = createExcalidrawPort(api)
      if (!IS_TAURI) {
        const key = localStorage.getItem(KEY_STORAGE)
        if (key && !convRef.current) ensureConversation(key)
      } else if (!convRef.current) {
        tauriKey.has().then((has) => {
          if (has && !convRef.current) ensureConversation()
        })
      }
    },
    [ensureConversation],
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

  const saveApiKey = async () => {
    const key = apiKeyInput.trim()
    if (!key) return
    if (IS_TAURI) {
      await tauriKey.set(key)
      ensureConversation()
    } else {
      localStorage.setItem(KEY_STORAGE, key)
      ensureConversation(key)
    }
    setApiKeySet(true)
    setApiKeyInput('')
  }

  const clearApiKey = async () => {
    if (IS_TAURI) await tauriKey.clear()
    else localStorage.removeItem(KEY_STORAGE)
    setApiKeySet(false)
    setApiKeyInput('')
  }

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
      const engine = engines.find((e) => e.id === targetEngineId)
      if (!engine) return
      // The API canvas engine needs a live Conversation; create it on first use.
      if (targetEngineId === 'canvas' && !convRef.current) {
        if (IS_TAURI) ensureConversation()
        else {
          const key = localStorage.getItem(KEY_STORAGE)
          if (!key) return
          ensureConversation(key)
        }
      }

      addMessage('user', text)
      setBusy(true)
      // Lazily open an assistant bubble on the first text; a system note closes it so the next
      // text starts a fresh bubble below — keeps Claude's "progress then prose" ordering readable.
      let assistantId: string | null = null
      try {
        await engine.send(text, {
          onText: (delta) => {
            if (!assistantId) assistantId = addMessage('assistant', '')
            appendToMessage(assistantId, delta)
          },
          onSystem: (note) => {
            addMessage('system', note)
            assistantId = null
          },
          onQuestion: (question) => {
            addQuestionMessage(question, targetEngineId)
            assistantId = null
          },
          onRequest: debug
            ? (params, i) => addMessage('debug', formatRequest(params, i), requestImage(params))
            : undefined,
          onDebug: debug ? (t) => addMessage('debug', t) : undefined,
        })
      } catch (e) {
        // Not every throw is an Error: a Tauri command rejects with its Rust Err string, which
        // has no `.message` (it showed as "undefined"). Surface whatever it actually is.
        const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e)
        addMessage('system', `出错：${msg || '(空错误)'}`)
      } finally {
        setBusy(false)
      }
    },
    [engines, ensureConversation, debug],
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
      if (!question || question.answer) return
      const answerText = formatQuestionAnswer(question, answers)
      if (!answerText.trim()) return
      const engine = engines.find((item) => item.id === question.engineId)
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
          await sendToEngine(question.engineId, answerText)
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
    downloadProject(buildProject(port, messages, convRef.current?.messages ?? []))
  }, [messages])

  const onLoad = useCallback(async () => {
    const port = portRef.current
    if (!port) return
    const project = await openProjectFile()
    if (!project) return
    restoreCanvas(port, project)
    setMessages(project.display)
    convRef.current?.reset(project.api)
  }, [])

  const isLocalAgent = engineId.includes('claude') || engineId.includes('codex')
  const canSend = isLocalAgent ? !!cwd.trim() : apiKeySet
  const placeholder = canSend
    ? text.app.placeholderReady
    : isLocalAgent
      ? text.app.openProjectFirst
      : text.app.apiKeyFirst
  // The Claude canvas engine's config row is just the session switcher now; 打开工程 moved to the file
  // panel, the claude path to Settings, and the cwd input is gone (the folder is set by 打开工程).
  const engineConfig =
    (engineId === 'canvas-claude' || engineId === 'canvas-codex') ? (
      <PickerBar
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
    ) : undefined
  const activeActivityLabel = text.activity.labels[activeActivity]

  return (
    <>
    {/* Shell: 文件左 · 画布中 · 对话右. Panes are data-driven (width/shown state above), so widths
        drag-resize and the file pane hides — and a future VSCode-style rearrange only touches that
        state. The file pane is desktop-only; browser API mode is just 画布中 · 对话右. */}
    <div className="layout">
      {IS_TAURI && (
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
      )}
      <main className="canvas-pane">
        <Canvas onReady={onReady} />
        {/* Canvas picker floats over the canvas top-right (below Excalidraw's Library button). Only
            when a project is open — canvases are a project concept, decoupled from sessions. */}
        {ws.activeCanvasId && (
          <div className="canvas-bar">
            <PickerBar
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
          engines={visibleEngines.map((e) => ({ id: e.id, label: e.label }))}
          engineId={engineId}
          onSelectEngine={(id) => {
            setEngineId(id)
            localStorage.setItem(ENGINE_STORAGE, id)
          }}
          engineConfig={engineConfig}
          placeholder={placeholder}
          onSend={onSend}
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
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3 className="modal-title">{text.settings.title}</h3>
          <p className="modal-hint"><strong>{text.language.label}</strong></p>
          <select
            className="modal-input"
            value={language}
            onChange={(e) => setLanguage(parseUiLanguage(e.target.value))}
          >
            {uiLanguageOptions.map((id) => (
              <option key={id} value={id}>{text.language.options[id]}</option>
            ))}
          </select>
          <p className="modal-hint"><strong>{text.settings.apiSection}</strong></p>
          <p className="modal-hint">OpenAI-compatible URL</p>
          <input
            className="modal-input"
            autoFocus
            value={apiUrl}
            placeholder={POE_BASE_URL}
            onChange={(e) => {
              apiUrlRef.current = e.target.value
              setApiUrl(e.target.value)
              localStorage.setItem(API_URL_STORAGE, e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') setSettingsOpen(false)
            }}
            style={{ fontFamily: 'monospace' }}
          />
          <p className="modal-hint">{text.settings.apiKeyStatus} ({apiKeySet ? text.settings.apiKeySet : text.settings.apiKeyUnset})</p>
          <input
            className="modal-input"
            type="password"
            value={apiKeyInput}
            placeholder={apiKeySet ? text.settings.apiKeyKeep : text.settings.apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveApiKey()
              else if (e.key === 'Escape') setSettingsOpen(false)
            }}
          />
          <div className="modal-actions">
            <button onClick={clearApiKey}>{text.settings.clearKey}</button>
            <button className="primary" disabled={!apiKeyInput.trim()} onClick={saveApiKey}>{text.settings.saveKey}</button>
          </div>

          <p className="modal-hint"><strong>{text.settings.localAgentSection}</strong></p>
          <p className="modal-hint">
            {text.settings.executableHint}
          </p>
          <p className="modal-hint">Claude</p>
          <input
            className="modal-input"
            value={bin}
            placeholder={text.settings.claudePlaceholder}
            onChange={(e) => {
              binRef.current = e.target.value
              setBin(e.target.value)
              localStorage.setItem(BIN_STORAGE, e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') setSettingsOpen(false)
            }}
            style={{ fontFamily: 'monospace' }}
          />
          <p className="modal-hint">Codex</p>
          <input
            className="modal-input"
            value={codexBin}
            placeholder={text.settings.codexPlaceholder}
            onChange={(e) => {
              codexBinRef.current = e.target.value
              setCodexBin(e.target.value)
              localStorage.setItem(CODEX_BIN_STORAGE, e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') setSettingsOpen(false)
            }}
            style={{ fontFamily: 'monospace' }}
          />
          <div className="modal-actions">
            <button className="primary" onClick={() => setSettingsOpen(false)}>{text.common.done}</button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
