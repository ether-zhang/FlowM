import type { RunTurnParams } from '../llm'

/** What an engine reports back while producing a reply, mapped onto chat messages. */
export interface ChatCallbacks {
  /** Assistant prose — a streamed delta (canvas) or a whole block (Claude). */
  onText(text: string): void
  /** A system note: tool activity, a result/cost summary, a warning. */
  onSystem(text: string): void
  /** Debug hook: the exact request sent to the model. Canvas engine only; others ignore it. */
  onRequest?(params: RunTurnParams, iteration: number): void
}

/**
 * A backend the chat can talk to through one uniform `send`. The canvas assistant
 * (Conversation + port) and the Claude Code engine (local CLI) are both implementations;
 * the Chat UI and App route to whichever is selected without knowing which it is — the
 * same decoupling LlmAdapter gives the model providers.
 */
export interface ChatEngine {
  /** Stable id used for selection. */
  readonly id: string
  /** Human label for the engine selector. */
  readonly label: string
  send(text: string, cb: ChatCallbacks): Promise<void>
}
