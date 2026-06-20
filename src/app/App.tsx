import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { Canvas, createTldrawPort } from '../canvas'
import type { CanvasPort } from '../protocol'
import { PoeAdapter, TauriAdapter, tauriKey, Conversation } from '../llm'
import { Chat, type DisplayMessage } from '../chat'
import { buildProject, downloadProject, openProjectFile, restoreCanvas } from '../persistence'
import { IS_TAURI } from '../runtime'
import './app.css'

const KEY_STORAGE = 'flowm.apiKey'

export function App() {
  const editorRef = useRef<Editor | null>(null)
  const portRef = useRef<CanvasPort | null>(null)
  const convRef = useRef<Conversation | null>(null)

  // Browser: key lives in localStorage and is known synchronously.
  // Tauri: key lives in the Rust backend; resolve asynchronously below.
  const [apiKeySet, setApiKeySet] = useState(() =>
    IS_TAURI ? false : !!localStorage.getItem(KEY_STORAGE),
  )
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [busy, setBusy] = useState(false)

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

  const onEditor = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      portRef.current = createTldrawPort(editor)
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

  const addMessage = (role: DisplayMessage['role'], text: string) => {
    const id = crypto.randomUUID()
    setMessages((m) => [...m, { id, role, text }])
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
      const port = portRef.current
      if (!port) return

      let conv = convRef.current
      if (!conv) {
        if (IS_TAURI) {
          conv = ensureConversation()
        } else {
          const key = localStorage.getItem(KEY_STORAGE)
          if (!key) return
          conv = ensureConversation(key)
        }
      }

      addMessage('user', text)
      const assistantId = addMessage('assistant', '')
      setBusy(true)
      try {
        await conv.send(text, port, {
          onText: (delta) => appendToMessage(assistantId, delta),
          onToolsApplied: (summary) => addMessage('system', summary),
        })
      } catch (e) {
        addMessage('system', `出错：${(e as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    [ensureConversation],
  )

  const onSave = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    downloadProject(buildProject(editor, messages, convRef.current?.messages ?? []))
  }, [messages])

  const onLoad = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) return
    const project = await openProjectFile()
    if (!project) return
    restoreCanvas(editor, project)
    setMessages(project.display)
    convRef.current?.reset(project.api)
  }, [])

  return (
    <div className="layout">
      <main className="canvas-pane">
        <Canvas onEditor={onEditor} />
      </main>
      <aside className="chat-pane">
        <Chat
          messages={messages}
          busy={busy}
          apiKeySet={apiKeySet}
          onSend={onSend}
          onConfigureKey={onConfigureKey}
          onSave={onSave}
          onLoad={onLoad}
        />
      </aside>
    </div>
  )
}
