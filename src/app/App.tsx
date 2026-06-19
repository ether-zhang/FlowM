import { useCallback, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { Canvas, createTldrawPort } from '../canvas'
import type { CanvasPort } from '../protocol'
import { PoeAdapter, Conversation } from '../llm'
import { Chat, type DisplayMessage } from '../chat'
import { buildProject, downloadProject, openProjectFile, restoreCanvas } from '../persistence'
import './app.css'

const KEY_STORAGE = 'flowm.apiKey'

export function App() {
  const editorRef = useRef<Editor | null>(null)
  const portRef = useRef<CanvasPort | null>(null)
  const convRef = useRef<Conversation | null>(null)

  const [apiKeySet, setApiKeySet] = useState(() => !!localStorage.getItem(KEY_STORAGE))
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [busy, setBusy] = useState(false)

  const ensureConversation = useCallback((key: string) => {
    const adapter = new PoeAdapter(key)
    const prev = convRef.current
    const conv = new Conversation(adapter)
    if (prev) conv.reset(prev.messages) // preserve history across key changes
    convRef.current = conv
    return conv
  }, [])

  const onEditor = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      portRef.current = createTldrawPort(editor)
      const key = localStorage.getItem(KEY_STORAGE)
      if (key && !convRef.current) ensureConversation(key)
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

  const onConfigureKey = useCallback(() => {
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
      const key = localStorage.getItem(KEY_STORAGE)
      if (!port || !key) return
      const conv = convRef.current ?? ensureConversation(key)

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
