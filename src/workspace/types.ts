/**
 * The workspace model for the VSCode-plugin-style shell. Decisions (confirmed):
 *  - 工程 = 代码文件夹: a project binds to one code folder; FlowM's own state lives under ~/.flowm,
 *    while per-invocation canvas artifacts live under the project's gitignored .flowm folder.
 *  - Logical conversations and execution bindings are owned by the native harness.
 *  - 画布 ⊥ session: canvases and sessions are INDEPENDENT lists under a project. A new canvas does
 *    NOT create a session and vice-versa; the active session (a chat thread) drives whatever the
 *    active canvas (a drawing surface) currently is.
 */

/** A legacy project record, used only for idempotent migration into the harness. */
export interface SessionMeta {
  id: string
  name: string
  /** Private FlowM bindings. Unknown historical fields are preserved by storage parsing. */
  harnessThreads?: Record<string, string>
}

/** A drawing surface (its scene is persisted separately, keyed by id). */
export interface CanvasMeta {
  id: string
  name: string
}

/** Per-project record at ~/.flowm/<projectId>/project.json. */
export interface ProjectMeta {
  version: number
  /** Absolute path of the code folder this project is bound to. */
  folder: string
  legacySessions?: SessionMeta[]
  canvases: CanvasMeta[]
}

/** One row in the workspace index (~/.flowm/workspace.json). */
export interface WorkspaceEntry {
  id: string
  folder: string
  name: string
  lastOpened: number
}

export interface Workspace {
  version: number
  projects: WorkspaceEntry[]
}
