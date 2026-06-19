import type { ToolDef } from '../protocol'
import type { LlmMessage, LlmTurn } from './types'

/** Callbacks fired while a turn is produced. */
export interface TurnCallbacks {
  /** Assistant text for this turn (full text on non-streaming adapters). */
  onText(text: string): void
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
}
