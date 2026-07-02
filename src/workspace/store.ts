import { invoke } from '@tauri-apps/api/core'
import type { DisplayMessage } from '../chat/types'
import type { ProjectMeta, Workspace } from './types'

/**
 * The ~/.flowm store, backed by the Rust `flowm_read`/`flowm_write`/`list_dir`/`pick_folder`
 * commands (desktop only). Layout:
 *   workspace.json                     — the project index
 *   <projectId>/project.json           — a project's sessions + canvases + bound folder
 *   <projectId>/sess-<sessId>.json     — a session's UI bubbles (Claude's session holds the history)
 *   <projectId>/canvas-<canvasId>.json — a canvas's scene (CanvasPort.serialize output)
 */

const read = (rel: string) => invoke<string | null>('flowm_read', { rel })
const write = (rel: string, content: string) => invoke<void>('flowm_write', { rel, content })

/** One entry from the file-panel directory listing (dirs first, then name). */
export interface FsEntry {
  name: string
  path: string
  isDir: boolean
}
export const listDir = (path: string) => invoke<FsEntry[]>('list_dir', { path })

/** Native folder picker; resolves to the chosen absolute path, or null if cancelled. */
export const pickFolder = () => invoke<string | null>('pick_folder')

/** Read a file's text (for the floating editor); rejects on >2MB / binary / missing. */
export const readFile = (path: string) => invoke<string>('read_file', { path })
/** Write edited text back to a file (the floating editor's Save). */
export const writeFile = (path: string, content: string) => invoke<void>('write_file', { path, content })

const WORKSPACE = 'workspace.json'
const projMetaPath = (id: string) => `${id}/project.json`
const sessPath = (projId: string, sessId: string) => `${projId}/sess-${sessId}.json`
const canvasPath = (projId: string, canvasId: string) => `${projId}/canvas-${canvasId}.json`

export async function loadWorkspace(): Promise<Workspace> {
  const raw = await read(WORKSPACE)
  return raw ? (JSON.parse(raw) as Workspace) : { version: 1, projects: [] }
}

export async function saveWorkspace(ws: Workspace): Promise<void> {
  await write(WORKSPACE, JSON.stringify(ws, null, 2))
}

/**
 * Open (or first-time create) the project bound to `folder`: ensure a workspace-index row, bump its
 * lastOpened, and load (or seed) its project.json. Idempotent — reopening the same folder returns
 * the existing project. Migrates a pre-decoupling meta (which had `conversations`) to empty
 * sessions/canvases so old projects don't crash the new model.
 */
export async function openProject(folder: string): Promise<{ id: string; meta: ProjectMeta }> {
  const ws = await loadWorkspace()
  let entry = ws.projects.find((p) => p.folder === folder)
  if (!entry) {
    entry = { id: crypto.randomUUID().slice(0, 8), folder, name: folderName(folder), lastOpened: Date.now() }
    ws.projects.push(entry)
  }
  entry.lastOpened = Date.now()
  await saveWorkspace(ws)

  const raw = await read(projMetaPath(entry.id))
  const parsed = raw ? (JSON.parse(raw) as Partial<ProjectMeta>) : null
  const meta: ProjectMeta = {
    version: 1,
    folder,
    sessions: parsed?.sessions ?? [],
    canvases: parsed?.canvases ?? [],
  }
  return { id: entry.id, meta }
}

export const saveProject = (id: string, meta: ProjectMeta): Promise<void> =>
  write(projMetaPath(id), JSON.stringify(meta, null, 2))

/** A session's UI bubbles (the model history lives in Claude's session, reached via --resume). */
export async function loadSessionDisplay(projId: string, sessId: string): Promise<DisplayMessage[] | null> {
  const raw = await read(sessPath(projId, sessId))
  return raw ? (JSON.parse(raw) as { display: DisplayMessage[] }).display : null
}
export const saveSessionDisplay = (projId: string, sessId: string, display: DisplayMessage[]): Promise<void> =>
  write(sessPath(projId, sessId), JSON.stringify({ display }))

/** A canvas's opaque scene (CanvasPort.serialize output). */
export async function loadCanvasScene(projId: string, canvasId: string): Promise<unknown | null> {
  const raw = await read(canvasPath(projId, canvasId))
  return raw ? (JSON.parse(raw) as { scene: unknown }).scene : null
}
export const saveCanvasScene = (projId: string, canvasId: string, scene: unknown): Promise<void> =>
  write(canvasPath(projId, canvasId), JSON.stringify({ scene }))

/** The last path segment of a folder, used as the project's display name. */
export function folderName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}
