import type { AgentQuestion } from '../agent'

/**
 * Provider-neutral conversation types. The conversation loop and the rest of the
 * app speak only these; the harness canvas boundary maps native results into this
 * format. This keeps FlowM independent of any single LLM API.
 */

export interface LlmToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export type LlmQuestion = AgentQuestion

export type LlmMessage =
  | { role: 'user'; content: string; image?: string } // image: a PNG data URL (canvas selection)
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

/** Result of one assistant turn. */
export interface LlmTurn {
  text: string
  toolCalls: LlmToolCall[]
  question?: LlmQuestion
}
