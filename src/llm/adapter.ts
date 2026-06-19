import type Anthropic from '@anthropic-ai/sdk'

/** Callbacks fired while one assistant turn streams. */
export interface TurnCallbacks {
  onText(delta: string): void
}

export interface StreamTurnParams {
  system: string
  messages: Anthropic.MessageParam[]
  tools: Anthropic.Tool[]
}

/**
 * Abstracts *where and how* an assistant turn is produced. The direct-Claude
 * implementation lives in claude.ts; a future agent bridge (claude code / codex)
 * is just another implementation of this interface — the conversation loop and
 * the rest of the app never change.
 */
export interface LlmAdapter {
  /** Stream one assistant turn; resolve with the final message (text + tool_use blocks). */
  streamTurn(params: StreamTurnParams, cb: TurnCallbacks): Promise<Anthropic.Message>
}
