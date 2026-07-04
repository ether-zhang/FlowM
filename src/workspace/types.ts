/**
 * The workspace model for the VSCode-plugin-style shell. Decisions (confirmed):
 *  - 工程 = 代码文件夹: a project binds to one code folder; FlowM's own state lives under ~/.flowm,
 *    the code folder only gets the gitignored CLAUDE.local.md the canvas engine writes.
 *  - 每对话一条 session: each local agent stores its own resume id on the session. FlowM keeps no
 *    parallel model history; the agent session is the history, FlowM persists only the UI bubbles.
 *  - 画布 ⊥ session: canvases and sessions are INDEPENDENT lists under a project. A new canvas does
 *    NOT create a session and vice-versa; the active session (a chat thread) drives whatever the
 *    active canvas (a drawing surface) currently is.
 */

/** A chat thread, with per-agent resume handles. */
export interface SessionMeta {
  id: string
  name: string
  /** Claude Code session id (the --resume handle); captured after the first turn. */
  sessionId?: string
  /** Codex thread id (`codex exec resume` handle); captured after the first turn. */
  codexSessionId?: string
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
  sessions: SessionMeta[]
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
