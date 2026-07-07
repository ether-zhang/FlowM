import { useCallback, useRef, useState } from 'react'
import type { CanvasPort } from '../protocol'
import { ClaudeAdapter, CodexAdapter, Conversation } from '../llm'
import type { DisplayMessage } from '../chat/types'
import {
  deleteCanvasScene,
  deleteSessionDisplay,
  folderName,
  loadCanvasScene,
  loadSessionDisplay,
  openProject,
  pickFolder,
  saveCanvasScene,
  saveProject,
  saveSessionDisplay,
} from './store'
import type { CanvasMeta, ProjectMeta, SessionMeta } from './types'

export type AgentKind = 'claude' | 'codex'

/** One local agent runtime for a FlowM session. Kept alive across switches so the adapter's
 *  resume/delta continuity holds. */
interface AgentRuntime {
  conv: Conversation
  adapter: ClaudeAdapter | CodexAdapter
}

interface Runtime {
  claude?: AgentRuntime
  codex?: AgentRuntime
}

export interface WorkspaceApi {
  projectName: string | null
  // Sessions = chat threads (each its own Claude session).
  sessions: SessionMeta[]
  activeSessionId: string | null
  newSession: () => Promise<void>
  selectSession: (id: string) => Promise<void>
  renameSession: (id: string, name: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  // Canvases = drawing surfaces, INDEPENDENT of sessions (画布 ⊥ session).
  canvases: CanvasMeta[]
  activeCanvasId: string | null
  newCanvas: () => Promise<void>
  selectCanvas: (id: string) => Promise<void>
  renameCanvas: (id: string, name: string) => Promise<void>
  deleteCanvas: (id: string) => Promise<void>
  // Shared.
  openFolder: () => Promise<void>
  /** Persist the active session's bubbles + the active canvas's scene — call after each send. */
  persistActive: () => Promise<void>
  /** The active session's Conversation, for local-agent canvas engines (null = no project). */
  activeConv: (agent?: AgentKind) => Conversation | null
}

/**
 * The project layer for the shell. Sits ABOVE the engines and is active only once a folder is opened;
 * until then `activeConv()` is null and App falls back to its legacy single conversation, so nothing
 * about the pre-project flow breaks.
 *
 * Canvases and sessions are DECOUPLED: a session is a Claude chat thread (每对话一条 session), a canvas
 * is a drawing surface, and they are separate lists. The active session drives whatever the active
 * canvas currently is — creating one never creates the other. FlowM persists bubbles per session and
 * the scene per canvas to ~/.flowm; Claude's own session holds the model history (via --resume).
 *
 * Decoupling: this hook knows only CanvasPort + the store + the LLM Conversation — never Excalidraw or
 * App's widgets. App feeds it accessors (get/set messages, get port/cwd/bin, set folder).
 */
export function useWorkspace(opts: {
  getPort: () => CanvasPort | null
  getMessages: () => DisplayMessage[]
  setMessages: (m: DisplayMessage[]) => void
  getCwd: () => string
  getBin: () => string
  getCodexBin: () => string
  setFolder: (folder: string) => void
}): WorkspaceApi {
  const [projectName, setProjectName] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [canvases, setCanvases] = useState<CanvasMeta[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null)

  const projIdRef = useRef<string | null>(null)
  const metaRef = useRef<ProjectMeta | null>(null)
  const runtimes = useRef(new Map<string, Runtime>())
  const activeSessRef = useRef<string | null>(null)
  const activeCanvasRef = useRef<string | null>(null)

  const ensureRuntime = useCallback(
    (sm: SessionMeta, agent: AgentKind): AgentRuntime => {
      let rt = runtimes.current.get(sm.id)
      if (!rt) {
        rt = {}
        runtimes.current.set(sm.id, rt)
      }
      if (!rt[agent]) {
        const adapter =
          agent === 'claude'
            ? new ClaudeAdapter(opts.getCwd, opts.getBin, sm.sessionId ?? null)
            : new CodexAdapter(opts.getCwd, opts.getCodexBin, sm.codexSessionId ?? null)
        rt[agent] = { conv: new Conversation(adapter), adapter }
      }
      return rt[agent]
    },
    [opts],
  )

  const syncLists = useCallback(() => {
    setSessions(metaRef.current ? [...metaRef.current.sessions] : [])
    setCanvases(metaRef.current ? [...metaRef.current.canvases] : [])
  }, [])

  /** Write project.json, first folding each live adapter's captured session id into its meta. */
  const persistMeta = useCallback(async () => {
    if (!projIdRef.current || !metaRef.current) return
    for (const sm of metaRef.current.sessions) {
      const rt = runtimes.current.get(sm.id)
      const claudeSid = rt?.claude?.adapter.sessionId
      const codexSid = rt?.codex?.adapter.sessionId
      if (claudeSid) sm.sessionId = claudeSid
      if (codexSid) sm.codexSessionId = codexSid
    }
    await saveProject(projIdRef.current, metaRef.current)
  }, [])

  const persistActiveSession = useCallback(async () => {
    const id = activeSessRef.current
    if (id && projIdRef.current) await saveSessionDisplay(projIdRef.current, id, opts.getMessages())
  }, [opts])

  const persistActiveCanvas = useCallback(async () => {
    const id = activeCanvasRef.current
    const port = opts.getPort()
    if (id && projIdRef.current && port) await saveCanvasScene(projIdRef.current, id, port.serialize())
  }, [opts])

  const persistActive = useCallback(async () => {
    await persistActiveSession()
    await persistActiveCanvas()
    await persistMeta()
  }, [persistActiveSession, persistActiveCanvas, persistMeta])

  const activateSession = useCallback(
    async (sm: SessionMeta) => {
      const display = projIdRef.current ? await loadSessionDisplay(projIdRef.current, sm.id) : null
      opts.setMessages(display ?? [])
      activeSessRef.current = sm.id
      setActiveSessionId(sm.id)
    },
    [ensureRuntime, opts],
  )

  const activateCanvas = useCallback(
    async (cm: CanvasMeta) => {
      const scene = projIdRef.current ? await loadCanvasScene(projIdRef.current, cm.id) : null
      opts.getPort()?.deserialize(scene ?? [])
      activeCanvasRef.current = cm.id
      setActiveCanvasId(cm.id)
    },
    [opts],
  )

  const selectSession = useCallback(
    async (id: string) => {
      if (id === activeSessRef.current) return
      await persistActiveSession()
      const sm = metaRef.current?.sessions.find((s) => s.id === id)
      if (sm) await activateSession(sm)
    },
    [persistActiveSession, activateSession],
  )

  const selectCanvas = useCallback(
    async (id: string) => {
      if (id === activeCanvasRef.current) return
      await persistActiveCanvas()
      const cm = metaRef.current?.canvases.find((c) => c.id === id)
      if (cm) await activateCanvas(cm)
    },
    [persistActiveCanvas, activateCanvas],
  )

  const newSession = useCallback(async () => {
    if (!metaRef.current) return
    await persistActiveSession()
    const sm: SessionMeta = { id: crypto.randomUUID().slice(0, 8), name: `Conversation ${metaRef.current.sessions.length + 1}` }
    metaRef.current.sessions.push(sm)
    syncLists()
    await activateSession(sm)
    await persistMeta()
  }, [persistActiveSession, activateSession, syncLists, persistMeta])

  const newCanvas = useCallback(async () => {
    if (!metaRef.current) return
    await persistActiveCanvas()
    const cm: CanvasMeta = { id: crypto.randomUUID().slice(0, 8), name: `Canvas ${metaRef.current.canvases.length + 1}` }
    metaRef.current.canvases.push(cm)
    syncLists()
    await activateCanvas(cm)
    await persistMeta()
  }, [persistActiveCanvas, activateCanvas, syncLists, persistMeta])

  const renameSession = useCallback(
    async (id: string, name: string) => {
      const sm = metaRef.current?.sessions.find((s) => s.id === id)
      if (!sm || !name.trim()) return
      sm.name = name.trim()
      syncLists()
      await persistMeta()
    },
    [syncLists, persistMeta],
  )

  const deleteSession = useCallback(
    async (id: string) => {
      const meta = metaRef.current
      const projId = projIdRef.current
      if (!meta || !projId) return
      const idx = meta.sessions.findIndex((s) => s.id === id)
      if (idx < 0) return
      meta.sessions.splice(idx, 1)
      runtimes.current.delete(id)
      if (activeSessRef.current === id) {
        activeSessRef.current = null // don't re-save the deleted session on the next activate
        const next = meta.sessions[Math.min(idx, meta.sessions.length - 1)]
        if (next) {
          // Sync AFTER activation: the reduced list and the new highlight then land in one React
          // commit, instead of a flash of "no row active" across activateSession's IPC await.
          await activateSession(next)
          syncLists()
          await persistMeta()
        } else {
          await newSession() // always keep at least one; it syncs + persists itself
        }
      } else {
        syncLists()
        await persistMeta()
      }
      await deleteSessionDisplay(projId, id) // the data file goes with the meta entry
    },
    [syncLists, activateSession, newSession, persistMeta],
  )

  const renameCanvas = useCallback(
    async (id: string, name: string) => {
      const cm = metaRef.current?.canvases.find((c) => c.id === id)
      if (!cm || !name.trim()) return
      cm.name = name.trim()
      syncLists()
      await persistMeta()
    },
    [syncLists, persistMeta],
  )

  const deleteCanvas = useCallback(
    async (id: string) => {
      const meta = metaRef.current
      const projId = projIdRef.current
      if (!meta || !projId) return
      const idx = meta.canvases.findIndex((c) => c.id === id)
      if (idx < 0) return
      meta.canvases.splice(idx, 1)
      if (activeCanvasRef.current === id) {
        activeCanvasRef.current = null // don't re-save the deleted canvas on the next activate
        const next = meta.canvases[Math.min(idx, meta.canvases.length - 1)]
        if (next) {
          // Sync AFTER activation — one commit for the reduced list + new active id (no flicker).
          await activateCanvas(next)
          syncLists()
          await persistMeta()
        } else {
          await newCanvas() // always keep at least one; it syncs + persists itself
        }
      } else {
        syncLists()
        await persistMeta()
      }
      await deleteCanvasScene(projId, id) // the scene file goes with the meta entry
    },
    [syncLists, activateCanvas, newCanvas, persistMeta],
  )

  const openFolder = useCallback(async () => {
    const folder = await pickFolder()
    if (!folder) return
    await persistActive() // flush the previous project
    runtimes.current.clear()
    const { id, meta } = await openProject(folder)
    projIdRef.current = id
    metaRef.current = meta
    activeSessRef.current = null
    activeCanvasRef.current = null
    opts.setFolder(folder)
    setProjectName(folderName(folder))
    syncLists()
    // Seed one of each on first open, then activate the first session + first canvas.
    if (meta.sessions.length === 0) await newSession()
    else await activateSession(meta.sessions[0])
    if (meta.canvases.length === 0) await newCanvas()
    else await activateCanvas(meta.canvases[0])
  }, [persistActive, opts, syncLists, newSession, newCanvas, activateSession, activateCanvas])

  // Stable (reads refs), so the engine's getConv closure captured once stays live across switches.
  const activeConv = useCallback((agent: AgentKind = 'claude') => {
    const id = activeSessRef.current
    const sm = metaRef.current?.sessions.find((s) => s.id === id)
    return sm ? ensureRuntime(sm, agent).conv : null
  }, [ensureRuntime])

  return {
    projectName,
    sessions,
    activeSessionId,
    newSession,
    selectSession,
    renameSession,
    deleteSession,
    canvases,
    activeCanvasId,
    newCanvas,
    selectCanvas,
    renameCanvas,
    deleteCanvas,
    openFolder,
    persistActive,
    activeConv,
  }
}
