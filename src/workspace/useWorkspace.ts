import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasPort } from '../protocol'
import { Conversation, CanvasTurnProjection } from '../llm'
import { createCanvasTurn, createProjectSession, type HarnessConversations, type HarnessSession, type HarnessSessionMeta as SessionMeta, type HarnessConversationExport } from '../harness'
import {
  deleteCanvasScene,
  deleteLegacySession,
  folderName,
  loadCanvasScene,
  loadLegacySession,
  openProject,
  pickFolder,
  saveCanvasScene,
  saveProject,
} from './store'
import type { CanvasMeta, ProjectMeta } from './types'

interface Runtime {
  canvas?: Conversation
  project?: HarnessSession
}

async function disposeRuntime(runtime: Runtime | undefined): Promise<void> {
  if (!runtime) return
  await Promise.allSettled([runtime.canvas?.dispose(), runtime.project?.dispose()])
}

export interface WorkspaceApi {
  changing: boolean
  isChanging: () => boolean
  projectName: string | null
  // Harness owns logical conversations and their private canvas/project execution segments.
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
  /** Persist host-owned project metadata and the active canvas scene. */
  persistActive: () => Promise<void>
  /** The active session's Conversation, for local-agent canvas engines (null = no project). */
  activeConv: () => Conversation | null
  activeProject: () => HarnessSession | null
  importConversation(document: HarnessConversationExport | undefined, display: unknown[], context: unknown[]): Promise<void>
}

/** Selects harness-owned conversations and host-owned canvases independently.
 * Framework runtimes operate on the selected canvas; model state stays in the harness. */
export function useWorkspace(opts: {
  getPort: () => CanvasPort | null
  conversations: HarnessConversations
  getCwd: () => string
  isBusy: () => boolean
  setFolder: (folder: string) => void
}): WorkspaceApi {
  const [projectName, setProjectName] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [canvases, setCanvases] = useState<CanvasMeta[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const changingRef = useRef(false)

  const projIdRef = useRef<string | null>(null)
  const metaRef = useRef<ProjectMeta | null>(null)
  const sessionsRef = useRef<SessionMeta[]>([])
  const runtimes = useRef(new Map<string, Runtime>())
  const activeSessRef = useRef<string | null>(null)
  const activeCanvasRef = useRef<string | null>(null)
  const transition = async (operation: () => Promise<void>) => {
    if (opts.isBusy() || changingRef.current) return
    changingRef.current = true
    setChanging(true)
    try { await operation() } finally { changingRef.current = false; setChanging(false) }
  }
  const isChanging = useCallback(() => changingRef.current, [])

  const ensureRuntime = useCallback(
    (sm: SessionMeta, role: 'canvas' | 'project'): Runtime | null => {
      const runtimeKey = sm.id
      let rt = runtimes.current.get(runtimeKey)
      if (!rt) {
        rt = {}
        runtimes.current.set(runtimeKey, rt)
      }
      if (!rt[role]) {
        const scope = { projectRoot: sm.projectRoot, flowSessionId: sm.id, getExecution: opts.conversations.getExecution }
        if (role === 'canvas') {
          const turn = createCanvasTurn(scope)
          rt.canvas = new Conversation(new CanvasTurnProjection(turn))
        } else {
          rt.project = createProjectSession(scope)
        }
      }
      return rt
    },
    [opts],
  )

  const syncLists = useCallback(() => {
    setSessions([...sessionsRef.current])
    setCanvases(metaRef.current ? [...metaRef.current.canvases] : [])
  }, [])

  /** Persist host-owned project metadata. */
  const persistMeta = useCallback(async () => {
    if (!projIdRef.current || !metaRef.current) return
    await saveProject(projIdRef.current, metaRef.current)
  }, [])

  const persistActiveCanvas = useCallback(async () => {
    const id = activeCanvasRef.current
    const port = opts.getPort()
    if (id && projIdRef.current && port) await saveCanvasScene(projIdRef.current, id, port.serialize())
  }, [opts])

  const persistActive = useCallback(async () => {
    await persistActiveCanvas()
    await persistMeta()
  }, [persistActiveCanvas, persistMeta])

  const activateSession = useCallback(
    async (sm: SessionMeta) => {
      await opts.conversations.select(sm.projectRoot, sm.id)
      activeSessRef.current = sm.id
      setActiveSessionId(sm.id)
    },
    [opts],
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
      if (opts.isBusy()) return
      if (id === activeSessRef.current) return
      const sm = sessionsRef.current.find((s) => s.id === id)
      if (sm) await activateSession(sm)
    },
    [activateSession, opts],
  )

  const selectCanvas = useCallback(
    async (id: string) => {
      if (opts.isBusy()) return
      if (id === activeCanvasRef.current) return
      await persistActiveCanvas()
      const cm = metaRef.current?.canvases.find((c) => c.id === id)
      if (cm) await activateCanvas(cm)
    },
    [persistActiveCanvas, activateCanvas, opts],
  )

  const newSession = useCallback(async () => {
    if (opts.isBusy()) return
    if (!metaRef.current) return
    const sm = await opts.conversations.create(opts.getCwd(), `Conversation ${sessionsRef.current.length + 1}`)
    sessionsRef.current = await opts.conversations.list(opts.getCwd())
    syncLists()
    await activateSession(sm)
  }, [activateSession, syncLists, opts])

  const newCanvas = useCallback(async () => {
    if (opts.isBusy()) return
    if (!metaRef.current) return
    await persistActiveCanvas()
    const cm: CanvasMeta = { id: crypto.randomUUID().slice(0, 8), name: `Canvas ${metaRef.current.canvases.length + 1}` }
    metaRef.current.canvases.push(cm)
    syncLists()
    await activateCanvas(cm)
    await persistMeta()
  }, [persistActiveCanvas, activateCanvas, syncLists, persistMeta, opts])

  const renameSession = useCallback(
    async (id: string, name: string) => {
      const sm = sessionsRef.current.find((s) => s.id === id)
      if (!sm || !name.trim()) return
      await opts.conversations.rename(sm.projectRoot, id, name.trim())
      sessionsRef.current = await opts.conversations.list(opts.getCwd())
      syncLists()
    },
    [syncLists, opts],
  )

  const deleteSession = useCallback(
    async (id: string) => {
      if (opts.isBusy()) return
      const meta = metaRef.current
      const projId = projIdRef.current
      if (!meta || !projId) return
      const idx = sessionsRef.current.findIndex((s) => s.id === id)
      if (idx < 0) return
      const sm = sessionsRef.current[idx]
      for (const [key, runtime] of runtimes.current) {
        if (key === id) { await disposeRuntime(runtime); runtimes.current.delete(key) }
      }
      await opts.conversations.delete(sm.projectRoot, id)
      sessionsRef.current = await opts.conversations.list(opts.getCwd())
      if (activeSessRef.current === id) {
        activeSessRef.current = null // don't re-save the deleted session on the next activate
        const next = sessionsRef.current[Math.min(idx, sessionsRef.current.length - 1)]
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
      await deleteLegacySession(projId, id)
    },
    [syncLists, activateSession, newSession, persistMeta, opts],
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
      if (opts.isBusy()) return
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
    [syncLists, activateCanvas, newCanvas, persistMeta, opts],
  )

  const openFolder = useCallback(async () => {
    if (opts.isBusy()) return
    const folder = await pickFolder()
    if (!folder || opts.isBusy()) return
    await persistActive() // flush the previous project
    await Promise.all([...runtimes.current.values()].map(disposeRuntime))
    runtimes.current.clear()
    const { id, meta } = await openProject(folder)
    if (meta.version < 2) {
      for (const legacy of meta.legacySessions ?? []) {
        const { display, context } = await loadLegacySession(id, legacy.id)
        await opts.conversations.importLegacy(folder, legacy.name, display, context, legacy, legacy.id)
      }
      // Originals remain readable for rollback. The workspace no longer writes conversation data.
      meta.version = 2
      meta.legacySessions = []
      await saveProject(id, meta)
    }
    sessionsRef.current = await opts.conversations.list(folder)
    projIdRef.current = id
    metaRef.current = meta
    activeSessRef.current = null
    activeCanvasRef.current = null
    opts.setFolder(folder)
    setProjectName(folderName(folder))
    syncLists()
    // Seed one of each on first open, then activate the first session + first canvas.
    if (sessionsRef.current.length === 0) await newSession()
    else await activateSession(sessionsRef.current[0])
    if (meta.canvases.length === 0) await newCanvas()
    else await activateCanvas(meta.canvases[0])
  }, [persistActive, opts, syncLists, newSession, newCanvas, activateSession, activateCanvas])

  useEffect(() => () => {
    const live = [...runtimes.current.values()]
    runtimes.current.clear()
    void Promise.all(live.map(disposeRuntime))
  }, [])

  // Stable (reads refs), so the engine's getConv closure captured once stays live across switches.
  const activeConv = useCallback(() => {
    const id = activeSessRef.current
    const sm = sessionsRef.current.find((s) => s.id === id)
    return sm ? ensureRuntime(sm, 'canvas')?.canvas ?? null : null
  }, [ensureRuntime])

  const activeProject = useCallback(() => {
    const sm = sessionsRef.current.find((session) => session.id === activeSessRef.current)
    return sm ? ensureRuntime(sm, 'project')?.project ?? null : null
  }, [ensureRuntime])


  const importConversation = useCallback(async (document: HarnessConversationExport | undefined, display: unknown[], context: unknown[]) => {
    if (opts.isBusy() || !metaRef.current) throw new Error('Open a project before importing a conversation')
    const sm = document
      ? await opts.conversations.importDocument(opts.getCwd(), document.meta.name, document)
      : await opts.conversations.importLegacy(opts.getCwd(), `Conversation ${sessionsRef.current.length + 1}`, display, context, {})
    sessionsRef.current = await opts.conversations.list(opts.getCwd())
    await activateSession(sm)
    syncLists()
  }, [opts, activateSession, syncLists])

  return {
    changing,
    isChanging,
    projectName,
    sessions,
    activeSessionId,
    newSession: () => transition(newSession),
    selectSession: (id) => transition(() => selectSession(id)),
    renameSession,
    deleteSession: (id) => transition(() => deleteSession(id)),
    canvases,
    activeCanvasId,
    newCanvas: () => transition(newCanvas),
    selectCanvas: (id) => transition(() => selectCanvas(id)),
    renameCanvas,
    deleteCanvas: (id) => transition(() => deleteCanvas(id)),
    openFolder: () => transition(openFolder),
    persistActive,
    activeConv,
    activeProject,
    importConversation,
  }
}
