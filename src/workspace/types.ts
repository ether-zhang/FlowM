/**
 * The workspace model for the VSCode-plugin-style shell. Decisions (confirmed):
 *  - 工程 = 代码文件夹: a project binds to one code folder; FlowM's own state lives under ~/.flowm,
 *    the code folder only gets the gitignored CLAUDE.local.md the canvas engine writes.
 *  - 每对话一条 session: a conversation IS one Claude Code session (the --resume chain). Its `kind`
 *    decides whether it owns a canvas (canvas) or is pure chat (text). FlowM keeps no parallel
 *    model history — Claude's session is the history; FlowM persists only the canvas + UI bubbles.
 */

export type ConversationKind = 'canvas' | 'text'

export interface ConversationMeta {
  id: string
  name: string
  kind: ConversationKind
  /** Claude Code session id (the --resume handle); captured after the first turn. */
  sessionId?: string
}

/** Per-project record at ~/.flowm/<projectId>/project.json. */
export interface ProjectMeta {
  version: number
  /** Absolute path of the code folder this project is bound to. */
  folder: string
  conversations: ConversationMeta[]
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
