import type { ToolDef } from '../protocol'
import type { AgentActivityEvent, AgentQuestion, AgentQuestionAnswer } from '../agent'
import type { LlmMessage, LlmTurn } from './types'

/** Callbacks fired while a turn is produced. */
export interface TurnCallbacks {
  /** Provider-native streamed prose, when the transport exposes it separately. */
  onText?(text: string): void
  /** Optional system-note channel (tool / progress activity → the chat's yellow hints, not the
   *  assistant bubble). The Poe adapter has none; the Claude Code adapter uses it to surface its
   *  Read/Grep progress while it works. */
  onSystem?(text: string): void
  /** Optional debug channel: the adapter reports its REAL outgoing request here, for adapters
   *  (e.g. Claude Code) that transform the request away from Conversation's logical view. */
  onDebug?(text: string): void
  /** Native agent request emitted while the current turn remains in flight. */
  onQuestion?(question: AgentQuestion): void
  /** Provider-neutral reasoning, tool lifecycle, and processing activity. */
  onActivity?(event: AgentActivityEvent): void
}

export interface RunTurnParams {
  phase: 'build' | 'review' | 'finalize'
  system: string
  messages: LlmMessage[]
  tools: ToolDef[]
}

/**
 * Keeps canvas turn orchestration independent of the model transport.
 * HarnessAdapter implements the packaged runtime boundary; model connections
 * and credentials are managed below that boundary.
 */
export interface LlmAdapter {
  /** Provider session handle persisted by the workspace, when this adapter owns one. */
  readonly sessionId?: string | null
  /** Produce one assistant turn; resolve with its text and any tool calls. */
  runTurn(params: RunTurnParams, cb: TurnCallbacks): Promise<LlmTurn>
  /** Answer a native in-flight question. Structured-output fallback adapters omit this. */
  answerQuestion?(answer: AgentQuestionAnswer): Promise<void>
  /** Cancel the current model turn without replaying its input. */
  cancel?(): Promise<void>
  /** Release any long-lived local transport owned by this adapter. */
  dispose?(): Promise<void>
}
