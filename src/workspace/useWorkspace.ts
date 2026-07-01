import { useCallback, useRef, useState } from 'react'
import type { CanvasPort } from '../protocol'
import { ClaudeAdapter, Conversation } from '../llm'
import type { DisplayMessage } from '../chat/types'
import {
  loadConversation,
  newConversation as newConvMeta,
  openProject,
  pickFolder,
  saveConversation,
  saveProject,
} from './store'
import type { ConversationKind, ConversationMeta, ProjectMeta } from './types'

/** One conversation's live runtime: its Conversation (message history) + the ClaudeAdapter whose
 *  session it owns. Kept alive across switches so the adapter's --resume/delta continuity holds. */
interface Runtime {
  conv: Conversation
  adapter: ClaudeAdapter
}

export interface WorkspaceApi {
  projectName: string | null
  conversations: ConversationMeta[]
  activeConvId: string | null
  openFolder: () => Promise<void>
  newConversation: (kind: ConversationKind) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  /** Persist the active conversation (canvas + bubbles + session id) — call after each send. */
  persistActive: () => Promise<void>
  /** The active conversation's Conversation, for the canvas engine's getConv (null = no project). */
  activeConv: () => Conversation | null
}

/**
 * The project/conversation layer for the shell. It sits ABOVE the existing engine machinery and is
 * only active once a folder is opened — until then `activeConv()` returns null and App falls back to
 * its legacy single conversation, so nothing about the current flow breaks. Each conversation is one
 * `Conversation(ClaudeAdapter)` with its OWN Claude session (每对话一条 session); FlowM persists the
 * canvas + bubbles to ~/.flowm while Claude's session holds the model history (reached via --resume).
 *
 * Decoupling: this hook knows only CanvasPort + the store + the LLM Conversation — never Excalidraw
 * or App's widgets. App feeds it accessors (get/set messages, get port/cwd/bin, set folder).
 */
export function useWorkspace(opts: {
  getPort: () => CanvasPort | null
  getMessages: () => DisplayMessage[]
  setMessages: (m: DisplayMessage[]) => void
  getCwd: () => string
  getBin: () => string
  setFolder: (folder: string) => void
}): WorkspaceApi {
  const [projectName, setProjectName] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)

  const projIdRef = useRef<string | null>(null)
  const metaRef = useRef<ProjectMeta | null>(null)
  const runtimes = useRef(new Map<string, Runtime>())
  const activeIdRef = useRef<string | null>(null)

  const ensureRuntime = useCallback(
    (cm: ConversationMeta): Runtime => {
      let rt = runtimes.current.get(cm.id)
      if (!rt) {
        const adapter = new ClaudeAdapter(opts.getCwd, opts.getBin, cm.sessionId ?? null)
        rt = { conv: new Conversation(adapter), adapter }
        runtimes.current.set(cm.id, rt)
      }
      return rt
    },
    [opts],
  )

  const syncConversations = useCallback(() => {
    setConversations(metaRef.current ? [...metaRef.current.conversations] : [])
  }, [])

  /** Write project.json, first folding each live adapter's captured session id into its meta. */
  const persistMeta = useCallback(async () => {
    if (!projIdRef.current || !metaRef.current) return
    for (const cm of metaRef.current.conversations) {
      const sid = runtimes.current.get(cm.id)?.adapter.sessionId
      if (sid) cm.sessionId = sid
    }
    await saveProject(projIdRef.current, metaRef.current)
  }, [])

  /** Save the active conversation's canvas + bubbles to the store (and refresh meta). */
  const persistActive = useCallback(async () => {
    const id = activeIdRef.current
    if (!id || !projIdRef.current || !metaRef.current) return
    const port = opts.getPort()
    await saveConversation(projIdRef.current, id, {
      canvas: port ? port.serialize() : undefined,
      display: opts.getMessages(),
    })
    await persistMeta()
  }, [opts, persistMeta])

  /** Make `cm` active: restore its canvas + bubbles (fresh = empty), ensure its runtime. */
  const activate = useCallback(
    async (cm: ConversationMeta) => {
      ensureRuntime(cm)
      const data = projIdRef.current ? await loadConversation(projIdRef.current, cm.id) : null
      const port = opts.getPort()
      if (port) port.deserialize(data?.canvas ?? [])
      opts.setMessages(data?.display ?? [])
      activeIdRef.current = cm.id
      setActiveConvId(cm.id)
    },
    [ensureRuntime, opts],
  )

  const selectConversation = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) return
      await persistActive() // save the outgoing conversation before swapping
      const cm = metaRef.current?.conversations.find((c) => c.id === id)
      if (cm) await activate(cm)
    },
    [persistActive, activate],
  )

  const newConversation = useCallback(
    async (kind: ConversationKind) => {
      if (!metaRef.current) return
      await persistActive()
      const n = metaRef.current.conversations.filter((c) => c.kind === kind).length + 1
      const cm = newConvMeta(kind, kind === 'canvas' ? `画布 ${n}` : `对话 ${n}`)
      metaRef.current.conversations.push(cm)
      syncConversations()
      await activate(cm)
      await persistMeta()
    },
    [persistActive, activate, syncConversations, persistMeta],
  )

  const openFolder = useCallback(async () => {
    const folder = await pickFolder()
    if (!folder) return
    await persistActive() // flush the previous project's active conversation
    runtimes.current.clear()
    const { id, meta } = await openProject(folder)
    projIdRef.current = id
    metaRef.current = meta
    activeIdRef.current = null
    opts.setFolder(folder)
    setProjectName(baseName(folder))
    syncConversations()
    if (meta.conversations.length === 0) await newConversation('canvas')
    else await activate(meta.conversations[0])
  }, [persistActive, opts, syncConversations, newConversation, activate])

  // Stable (reads refs), so the engine's getConv closure captured once stays live across switches.
  const activeConv = useCallback(() => {
    const id = activeIdRef.current
    return id ? runtimes.current.get(id)?.conv ?? null : null
  }, [])

  return { projectName, conversations, activeConvId, openFolder, newConversation, selectConversation, persistActive, activeConv }
}

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}
