import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Canvas, createExcalidrawPort } from '../canvas'
import type { CanvasPort } from '../protocol'
import { PoeAdapter, TauriAdapter, tauriKey, Conversation, type RunTurnParams } from '../llm'
import { Chat, type DisplayMessage } from '../chat'
import { buildProject, downloadProject, openProjectFile, restoreCanvas } from '../persistence'
import { CanvasEngine, ClaudeEngine, handleMcpRequest, type ChatEngine } from '../engine'
import { IS_TAURI } from '../runtime'
import './app.css'

const KEY_STORAGE = 'flowm.apiKey'

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

  // Selectable chat engines (decoupled behind ChatEngine). The canvas assistant always
  // exists; the local Claude Code engine only on desktop (it spawns a CLI). Engines read
  // live conv/port/cwd through getters, so they stay valid as those change.
  const cwdRef = useRef('D:\\Project\\vllm')
  const [cwd, setCwd] = useState(cwdRef.current)
  const enginesRef = useRef<ChatEngine[] | null>(null)
  if (!enginesRef.current) {
    const canvas = new CanvasEngine(() => convRef.current, () => portRef.current)
    // Two Claude engines share one transport, differing only by direction: 'build' (画布→工程)
    // and 'draw' (工程→画布). Expressing the mode as separate engine entries keeps the engine
    // self-contained (mode is a ctor arg, not React state) and reuses the existing selector.
    enginesRef.current = IS_TAURI
      ? [
          canvas,
          new ClaudeEngine(() => cwdRef.current, () => portRef.current),
          new ClaudeEngine(() => cwdRef.current, () => portRef.current, 'draw'),
          new ClaudeEngine(() => cwdRef.current, () => portRef.current, 'mcp'),
        ]
      : [canvas]
  }
  const engines = enginesRef.current
  const [engineId, setEngineId] = useState('canvas')

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

  // Canvas MCP bridge: the Rust server (mcp.rs) emits one event per Claude tool call; run it
  // against the live port and send the result back, so the spawned `claude` (mcp engine) can
  // read/edit the canvas. Registered once at mount — claude is spawned later, so the listener
  // is always ready; portRef is read live.
  useEffect(() => {
    if (!IS_TAURI) return
    const un = listen<{ rid: number; method: string; params: unknown }>('flowm://mcp-request', async (e) => {
      const { rid, method, params } = e.payload
      const result = await handleMcpRequest(method, params, portRef.current)
      await invoke('mcp_respond', { rid, result })
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

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

  const onConfigureKey = useCallback(async () => {
    if (IS_TAURI) {
      // Don't prefill — the key stays in the backend, never exposed to the renderer.
      const next = window.prompt('输入 Poe API Key（存于桌面后端，不进入渲染层）：', '')
      if (next == null) return
      const key = next.trim()
      if (!key) {
        await tauriKey.clear()
        setApiKeySet(false)
        return
      }
      await tauriKey.set(key)
      ensureConversation()
      setApiKeySet(true)
      return
    }

    const current = localStorage.getItem(KEY_STORAGE) ?? ''
    const next = window.prompt('输入 Poe API Key（仅存于本地 localStorage）：', current)
    if (next == null) return
    const key = next.trim()
    if (!key) {
      localStorage.removeItem(KEY_STORAGE)
      setApiKeySet(false)
      return
    }
    localStorage.setItem(KEY_STORAGE, key)
    ensureConversation(key)
    setApiKeySet(true)
  }, [ensureConversation])

  const onSend = useCallback(
    async (text: string) => {
      const engine = engines.find((e) => e.id === engineId)
      if (!engine) return
      // The canvas engine needs a live Conversation; create it on first use.
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
      // Lazily open an assistant bubble on the first text; a system note closes it so the
      // next text starts a fresh bubble below — keeps Claude's "tools then prose" ordering.
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
          onDebug: debug ? (text) => addMessage('debug', text) : undefined,
        })
      } catch (e) {
        addMessage('system', `出错：${(e as Error).message}`)
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

  const isClaude = engineId.startsWith('claude') // 'claude' (build) and 'claude-draw' both need a cwd
  const canSend = isClaude ? !!cwd.trim() : apiKeySet
  const placeholder = canSend
    ? '描述需求…（Enter 发送）'
    : isClaude
      ? '请先填写工程目录'
      : '请先设置 Poe API Key'
  const engineConfig = isClaude ? (
    <input
      value={cwd}
      onChange={(e) => {
        cwdRef.current = e.target.value
        setCwd(e.target.value)
      }}
      placeholder="工程目录 (cwd)，如 D:\Project\vllm"
      style={{ width: '100%', boxSizing: 'border-box', font: '12px monospace' }}
    />
  ) : undefined

  return (
    <div className="layout">
      <main className="canvas-pane">
        <Canvas onReady={onReady} />
      </main>
      <aside className="chat-pane">
        <Chat
          messages={messages}
          busy={busy}
          canSend={canSend}
          apiKeySet={apiKeySet}
          debug={debug}
          engines={engines.map((e) => ({ id: e.id, label: e.label }))}
          engineId={engineId}
          onSelectEngine={setEngineId}
          engineConfig={engineConfig}
          placeholder={placeholder}
          onSend={onSend}
          onConfigureKey={onConfigureKey}
          onToggleDebug={() => setDebug((d) => !d)}
          onSave={onSave}
          onLoad={onLoad}
        />
      </aside>
    </div>
  )
}
