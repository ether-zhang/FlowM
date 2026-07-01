export type {
  ConversationKind,
  ConversationMeta,
  ProjectMeta,
  WorkspaceEntry,
  Workspace,
} from './types'
export { FilePanel } from './FilePanel'
export { FloatingEditor } from './FloatingEditor'
export { ConversationList } from './ConversationList'
export { useWorkspace, type WorkspaceApi } from './useWorkspace'
export {
  type FsEntry,
  type ConversationData,
  readFile,
  writeFile,
  listDir,
  pickFolder,
  loadWorkspace,
  saveWorkspace,
  openProject,
  saveProject,
  loadConversation,
  saveConversation,
  newConversation,
} from './store'
