import type { ToolDef } from '../protocol'
import type { AgentQuestion, AgentQuestionAnswer } from '../agentControl'
import type { LlmMessage, LlmTurn } from './types'

/** Callbacks fired while a turn is produced. */
export interface TurnCallbacks {
  /** Assistant text for this turn (full text on non-streaming adapters). */
  onText(text: string): void
  /** Optional system-note channel (tool / progress activity → the chat's yellow hints, not the
   *  assistant bubble). The Poe adapter has none; the Claude Code adapter uses it to surface its
   *  Read/Grep progress while it works. */
  onSystem?(text: string): void
  /** Optional debug channel: the adapter reports its REAL outgoing request here, for adapters
   *  (e.g. Claude Code) that transform the request away from Conversation's logical view. */
  onDebug?(text: string): void
  /** Native agent request emitted while the current turn remains in flight. */
  onQuestion?(question: AgentQuestion): void
}

export interface RunTurnParams {
  system: string
  messages: LlmMessage[]
  tools: ToolDef[]
}

/**
 * Abstracts *where and how* an assistant turn is produced. The Poe (OpenAI-
 * compatible) implementation lives in poe.ts; a future direct-Anthropic adapter
 * or an agent bridge (claude code / codex) is just another implementation —
 * the conversation loop and the rest of the app never change.
 */
export interface LlmAdapter {
  /** Produce one assistant turn; resolve with its text and any tool calls. */
  runTurn(params: RunTurnParams, cb: TurnCallbacks): Promise<LlmTurn>
  /** Answer a native in-flight question. Structured-output fallback adapters omit this. */
  answerQuestion?(answer: AgentQuestionAnswer): Promise<void>
}
