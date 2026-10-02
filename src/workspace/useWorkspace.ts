import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasPort } from '../protocol'
import { Conversation } from '../llm'
import { HarnessAdapter } from '../llm/harnessAdapter'
import { HarnessSession, harnessClient, type HarnessProfile } from '../harness'
import { continuationContext, harnessBindingKey } from './harnessBindings'
import type { DisplayMessage } from '../chat/types'
import {
  deleteCanvasScene,
  deleteSessionDisplay,
  folderName,
  loadCanvasScene,
  loadSessionDisplay,
  openProject,
  pickFolder,
  pickHarnessHistory,
  saveCanvasScene,
  saveProject,
  saveSessionDisplay,
} from './store'
import type { CanvasMeta, ProjectMeta, SessionMeta } from './types'

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
  activeConv: () => Conversation | null
  activeProject: () => HarnessSession | null
  importHistory: () => Promise<void>
}

/**
 * The project layer for the shell. Sits ABOVE the engines and is active only once a folder is opened;
 * until then `activeConv()` is null. Local canvas agents are project-scoped and are created only
 * for a concrete FlowM session.
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
  getProfile: () => HarnessProfile | null
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
      const profile = opts.getProfile()
      if (!profile) return null
      const bindingKey = harnessBindingKey(profile, role)
      const runtimeKey = `${sm.id}\0${bindingKey}`
      let rt = runtimes.current.get(runtimeKey)
      if (!rt) {
        rt = {}
        runtimes.current.set(runtimeKey, rt)
      }
      if (!rt[role]) {
        const threadId = sm.harnessThreads?.[bindingKey]
        const importId = sm.harnessImports?.[bindingKey]
        const binding = { projectRoot: opts.getCwd(), flowSessionId: sm.id, profileId: profile.id, model: profile.model, ...(threadId ? { threadId } : {}), ...(importId && !threadId ? { importId } : {}) }
        const saveBinding = async (id: string) => {
          sm.harnessThreads = { ...sm.harnessThreads, [bindingKey]: id }
          if (projIdRef.current && metaRef.current) await saveProject(projIdRef.current, metaRef.current)
        }
        if (role === 'canvas') {
          const adapter = new HarnessAdapter(binding, threadId ? '' : continuationContext(opts.getMessages()), (request) => new HarnessSession(request, harnessClient, saveBinding))
          rt.canvas = new Conversation(adapter)
        } else {
          rt.project = new HarnessSession({ ...binding, role: 'project', system: '' }, harnessClient, saveBinding, threadId ? '' : continuationContext(opts.getMessages()))
        }
      }
      return rt
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
    // A native binding is persisted before its first model request, through saveBinding above.
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
      opts.setMessages((display ?? []).map((message) => message.question?.requestId && !message.question.answer ? { ...message, question: { ...message.question, expired: true } } : message))
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
      await persistActiveSession()
      const sm = metaRef.current?.sessions.find((s) => s.id === id)
      if (sm) await activateSession(sm)
    },
    [persistActiveSession, activateSession, opts],
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
    await persistActiveSession()
    const sm: SessionMeta = { id: crypto.randomUUID().slice(0, 8), name: `Conversation ${metaRef.current.sessions.length + 1}` }
    metaRef.current.sessions.push(sm)
    syncLists()
    await activateSession(sm)
    await persistMeta()
  }, [persistActiveSession, activateSession, syncLists, persistMeta, opts])

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
      if (opts.isBusy()) return
      const meta = metaRef.current
      const projId = projIdRef.current
      if (!meta || !projId) return
      const idx = meta.sessions.findIndex((s) => s.id === id)
      if (idx < 0) return
      meta.sessions.splice(idx, 1)
      for (const [key, runtime] of runtimes.current) {
        if (key.startsWith(`${id}\0`)) { await disposeRuntime(runtime); runtimes.current.delete(key) }
      }
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

  useEffect(() => () => {
    const live = [...runtimes.current.values()]
    runtimes.current.clear()
    void Promise.all(live.map(disposeRuntime))
  }, [])

  // Stable (reads refs), so the engine's getConv closure captured once stays live across switches.
  const activeConv = useCallback(() => {
    const id = activeSessRef.current
    const sm = metaRef.current?.sessions.find((s) => s.id === id)
    return sm ? ensureRuntime(sm, 'canvas')?.canvas ?? null : null
  }, [ensureRuntime])

  const activeProject = useCallback(() => {
    const sm = metaRef.current?.sessions.find((session) => session.id === activeSessRef.current)
    return sm ? ensureRuntime(sm, 'project')?.project ?? null : null
  }, [ensureRuntime])

  const importHistory = async () => {
    const profile = opts.getProfile()
    const sm = metaRef.current?.sessions.find((session) => session.id === activeSessRef.current)
    if (!profile || !sm || !projIdRef.current) return
    const filePath = await pickHarnessHistory()
    if (!filePath || opts.isBusy()) return
    const result = await harnessClient.importHistory(filePath, opts.getCwd())
    const key = harnessBindingKey(profile, 'canvas')
    if (sm.harnessImports?.[key] === result.importId) return
    await disposeRuntime(runtimes.current.get(`${sm.id}\0${key}`))
    runtimes.current.delete(`${sm.id}\0${key}`)
    if (sm.harnessThreads) delete sm.harnessThreads[key]
    sm.harnessImports = { ...sm.harnessImports, [key]: result.importId }
    await persistMeta()
  }

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
    importHistory: () => transition(importHistory),
  }
}
