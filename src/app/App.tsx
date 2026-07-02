import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Canvas, createExcalidrawPort } from '../canvas'
import type { CanvasPort } from '../protocol'
import { PoeAdapter, TauriAdapter, ClaudeAdapter, tauriKey, Conversation, type RunTurnParams } from '../llm'
import { Chat, type DisplayMessage } from '../chat'
import { FilePanel, FloatingEditor, ConversationList, CanvasBar, useWorkspace } from '../workspace'
import { Resizer } from './Resizer'
import { buildProject, downloadProject, openProjectFile, restoreCanvas } from '../persistence'
import { CanvasEngine, ClaudeEngine, defaultClaudeBin, type ChatEngine } from '../engine'
import { IS_TAURI } from '../runtime'
import './app.css'

const KEY_STORAGE = 'flowm.apiKey'
// Persisted across restarts so heavy iteration doesn't mean re-picking the engine + re-typing paths.
const CWD_STORAGE = 'flowm.cwd'
const BIN_STORAGE = 'flowm.bin'
const ENGINE_STORAGE = 'flowm.engine'
// Shell pane geometry (files left / chat right), persisted so the layout survives restarts.
const FILES_W_STORAGE = 'flowm.filesW'
const CHAT_W_STORAGE = 'flowm.chatW'
const FILES_SHOWN_STORAGE = 'flowm.filesShown'

const numFromStorage = (k: string, fallback: number) => {
  const n = Number(localStorage.getItem(k))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

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
  // Key entry uses an in-app dialog, NOT window.prompt: WKWebView (macOS Tauri) and WebKitGTK
  // (Linux) don't implement window.prompt — it returns null, so the key could never be set on
  // the desktop app. A React <input> works on every platform.
  const [keyDialogOpen, setKeyDialogOpen] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  // Settings dialog holds the claude executable path (moved out of the chat config row).
  const [settingsOpen, setSettingsOpen] = useState(false)

  // The working directory the local Claude Code engines run in (canvas·Claude + build).
  const cwdRef = useRef(localStorage.getItem(CWD_STORAGE) ?? '')
  const [cwd, setCwd] = useState(cwdRef.current)
  // Path to the user's `claude` executable; prefilled from the backend's platform default (see the
  // effect below). A GUI Mac app doesn't inherit the shell PATH, so an absolute path is what lets
  // `claude` spawn; empty means "resolve `claude` via PATH".
  const binRef = useRef(localStorage.getItem(BIN_STORAGE) ?? '')
  const [bin, setBin] = useState(binRef.current)

  // Shell pane geometry. Panels are data-driven (side + width + shown) so a future VSCode-style
  // rearrange only changes this state, not the render — the seam is here. Defaults keep the centre
  // canvas wide enough (>~730px on a normal window) that Excalidraw stays in desktop, not mobile, UI.
  const [filesW, setFilesW] = useState(() => numFromStorage(FILES_W_STORAGE, 240))
  const [chatW, setChatW] = useState(() => numFromStorage(CHAT_W_STORAGE, 340))
  const [filesShown, setFilesShown] = useState(() => localStorage.getItem(FILES_SHOWN_STORAGE) !== '0')
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

  // A second Conversation driven by Claude Code (same pipeline, different LlmAdapter). Needs no
  // API key — Claude auth is the user's own `claude auth login`. Desktop only.
  const claudeConvRef = useRef<Conversation | null>(null)
  if (IS_TAURI && !claudeConvRef.current) {
    claudeConvRef.current = new Conversation(new ClaudeAdapter(() => cwdRef.current, () => binRef.current))
  }

  // A live mirror of `messages` so the workspace's async save/switch reads the latest bubbles
  // (a state closure would be stale). Kept in sync by the effect below.
  const messagesRef = useRef<DisplayMessage[]>([])

  const setFolder = useCallback((folder: string) => {
    cwdRef.current = folder
    setCwd(folder)
    localStorage.setItem(CWD_STORAGE, folder)
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
    setFolder,
  })

  // Selectable chat engines (decoupled behind ChatEngine). They read live conv/port/cwd via
  // getters, so they stay valid as those are recreated. On desktop: the Poe canvas assistant,
  // the SAME canvas assistant backed by Claude Code, and the build engine (画布 → 工程).
  const enginesRef = useRef<ChatEngine[] | null>(null)
  if (!enginesRef.current) {
    const poe = new CanvasEngine(() => convRef.current, () => portRef.current, {
      id: 'canvas',
      label: IS_TAURI ? '画布助手 · Poe' : '画布助手',
    })
    enginesRef.current = IS_TAURI
      ? [
          poe,
          new CanvasEngine(() => ws.activeConv() ?? claudeConvRef.current, () => portRef.current, { id: 'canvas-claude', label: '画布助手 · Claude', debugViaAdapter: true }),
          new ClaudeEngine(() => cwdRef.current, () => portRef.current, () => binRef.current), // 画布 → 工程 (build)
        ]
      : [poe]
  }
  const engines = enginesRef.current
  const [engineId, setEngineId] = useState(() => {
    const saved = localStorage.getItem(ENGINE_STORAGE)
    return saved && engines.some((e) => e.id === saved) ? saved : 'canvas'
  })

  // Tauri's adapter needs no client-side key; the browser's PoeAdapter does.
  const ensureConversation = useCallback((key?: string) => {
    const adapter = IS_TAURI ? new TauriAdapter() : new PoeAdapter(key ?? '')
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

  const appendToMessage = (id: string, delta: string) =>
    setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, text: msg.text + delta } : msg)))

  // The Key button just opens the dialog; the input starts empty (the stored key is never
  // prefilled — in Tauri it lives in the backend and is never exposed to the renderer).
  const onConfigureKey = useCallback(() => {
    setKeyInput('')
    setKeyDialogOpen(true)
  }, [])

  // Save the dialog's key. Empty input clears the stored key. Storage branches by platform
  // (Tauri backend file vs localStorage); the rest is identical.
  const submitKey = useCallback(async () => {
    const key = keyInput.trim()
    setKeyDialogOpen(false)
    if (!key) {
      if (IS_TAURI) await tauriKey.clear()
      else localStorage.removeItem(KEY_STORAGE)
      setApiKeySet(false)
      return
    }
    if (IS_TAURI) {
      await tauriKey.set(key)
      ensureConversation()
    } else {
      localStorage.setItem(KEY_STORAGE, key)
      ensureConversation(key)
    }
    setApiKeySet(true)
  }, [keyInput, ensureConversation])

  const onSend = useCallback(
    async (text: string) => {
      const engine = engines.find((e) => e.id === engineId)
      if (!engine) return
      // The Poe canvas engine needs a live Conversation; create it on first use.
      if (engineId === 'canvas' && !convRef.current) {
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
    [engines, engineId, ensureConversation, debug],
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

  const isClaude = engineId.includes('claude') // canvas-claude + build both need a cwd, not a key
  const canSend = isClaude ? !!cwd.trim() : apiKeySet
  const placeholder = canSend
    ? '描述需求…（Enter 发送）'
    : isClaude
      ? '请先打开工程（右侧文件栏「打开工程」）'
      : '请先设置 Poe API Key'
  // The Claude canvas engine's config row is just the session switcher now; 打开工程 moved to the file
  // panel, the claude path to Settings, and the cwd input is gone (the folder is set by 打开工程).
  const engineConfig =
    engineId === 'canvas-claude' ? (
      <ConversationList
        projectName={ws.projectName}
        sessions={ws.sessions}
        activeSessionId={ws.activeSessionId}
        onNew={ws.newSession}
        onSelect={ws.selectSession}
      />
    ) : undefined

  return (
    <>
    {/* Shell: 文件左 · 画布中 · 对话右. Panes are data-driven (width/shown state above), so widths
        drag-resize and the file pane hides — and a future VSCode-style rearrange only touches that
        state. The file pane is desktop-only; browser (Poe) mode is just 画布中 · 对话右. */}
    <div className="layout">
      {IS_TAURI && filesShown && (
        <>
          <aside className="side-pane file-pane-wrap" style={{ width: filesW }}>
            <FilePanel folder={cwd} onOpenFile={setOpenFile} onOpenFolder={ws.openFolder} onHide={() => toggleFiles(false)} />
          </aside>
          <Resizer width={filesW} setWidth={persistFilesW} sign={1} />
        </>
      )}
      {IS_TAURI && !filesShown && (
        <button className="file-rail" onClick={() => toggleFiles(true)} title="显示文件栏">
          »
        </button>
      )}
      <main className="canvas-pane">
        <Canvas onReady={onReady} />
        {/* 新画布 + switcher float over the canvas top-right (below Excalidraw's Library button).
            Only when a project is open — canvases are a project concept, decoupled from sessions. */}
        {ws.activeCanvasId && (
          <CanvasBar
            canvases={ws.canvases}
            activeCanvasId={ws.activeCanvasId}
            onNew={ws.newCanvas}
            onSelect={ws.selectCanvas}
          />
        )}
      </main>
      <Resizer width={chatW} setWidth={persistChatW} sign={-1} />
      <aside className="side-pane chat-pane" style={{ width: chatW }}>
        <Chat
          messages={messages}
          busy={busy}
          canSend={canSend}
          apiKeySet={apiKeySet}
          debug={debug}
          engines={engines.map((e) => ({ id: e.id, label: e.label }))}
          engineId={engineId}
          onSelectEngine={(id) => {
            setEngineId(id)
            localStorage.setItem(ENGINE_STORAGE, id)
          }}
          engineConfig={engineConfig}
          placeholder={placeholder}
          onSend={onSend}
          onConfigureKey={onConfigureKey}
          onToggleDebug={() => setDebug((d) => !d)}
          onOpenSettings={() => setSettingsOpen(true)}
          onSave={onSave}
          onLoad={onLoad}
        />
      </aside>
    </div>

    {openFile && <FloatingEditor path={openFile} onClose={() => setOpenFile(null)} />}

    {settingsOpen && (
      <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3 className="modal-title">设置</h3>
          <p className="modal-hint">
            Claude 可执行文件路径。留空则用 PATH 中的 <code>claude</code>；GUI 应用可能不继承 shell PATH，填绝对路径最稳。
          </p>
          <input
            className="modal-input"
            autoFocus
            value={bin}
            placeholder="如 /Users/you/.local/bin/claude 或 claude.exe 的完整路径"
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
          <div className="modal-actions">
            <button className="primary" onClick={() => setSettingsOpen(false)}>完成</button>
          </div>
        </div>
      </div>
    )}

    {keyDialogOpen && (
      <div className="modal-backdrop" onClick={() => setKeyDialogOpen(false)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3 className="modal-title">设置 Poe API Key</h3>
          <p className="modal-hint">
            {IS_TAURI
              ? '存于桌面后端文件，不进入渲染层。留空并确定可清除。'
              : '仅存于本地 localStorage。留空并确定可清除。'}
          </p>
          <input
            className="modal-input"
            type="password"
            autoFocus
            value={keyInput}
            placeholder="在 poe.com/api/keys 获取"
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitKey()
              else if (e.key === 'Escape') setKeyDialogOpen(false)
            }}
          />
          <div className="modal-actions">
            <button onClick={() => setKeyDialogOpen(false)}>取消</button>
            <button className="primary" onClick={submitKey}>确定</button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
