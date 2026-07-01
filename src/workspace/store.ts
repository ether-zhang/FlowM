import { invoke } from '@tauri-apps/api/core'
import type { DisplayMessage } from '../chat/types'
import type { ConversationKind, ConversationMeta, ProjectMeta, Workspace } from './types'

/**
 * The ~/.flowm store, backed by the Rust `flowm_read`/`flowm_write`/`list_dir`/`pick_folder`
 * commands (desktop only). Layout:
 *   workspace.json                     — the project index
 *   <projectId>/project.json           — a project's conversations + bound folder
 *   <projectId>/conv-<convId>.json     — a conversation's canvas scene + UI bubbles
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

/** What FlowM persists per conversation. The model history is NOT here — it's in Claude's session
 *  (reached via --resume); we keep only what Claude's session doesn't: the canvas + the UI bubbles. */
export interface ConversationData {
  /** Excalidraw scene (CanvasPort.serialize output); only for canvas conversations. */
  canvas?: unknown
  display: DisplayMessage[]
}

const WORKSPACE = 'workspace.json'
const projMetaPath = (id: string) => `${id}/project.json`
const convDataPath = (projId: string, convId: string) => `${projId}/conv-${convId}.json`

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
 * the existing project, not a duplicate.
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
  const meta: ProjectMeta = raw ? (JSON.parse(raw) as ProjectMeta) : { version: 1, folder, conversations: [] }
  return { id: entry.id, meta }
}

export const saveProject = (id: string, meta: ProjectMeta): Promise<void> =>
  write(projMetaPath(id), JSON.stringify(meta, null, 2))

export async function loadConversation(projId: string, convId: string): Promise<ConversationData | null> {
  const raw = await read(convDataPath(projId, convId))
  return raw ? (JSON.parse(raw) as ConversationData) : null
}

export const saveConversation = (projId: string, convId: string, data: ConversationData): Promise<void> =>
  write(convDataPath(projId, convId), JSON.stringify(data))

/** A fresh conversation record (canvas or text); sessionId is filled in after its first turn. */
export function newConversation(kind: ConversationKind, name: string): ConversationMeta {
  return { id: crypto.randomUUID().slice(0, 8), name, kind }
}

/** The last path segment of a folder, used as the project's display name. */
function folderName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}
