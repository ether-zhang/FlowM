import type { RunTurnParams } from '../llm'
import type { AgentActivityEvent, AgentQuestion, AgentQuestionAnswer } from '../agentControl'

/** What an engine reports back while producing a reply, mapped onto chat messages. */
export interface ChatCallbacks {
  /** Assistant prose — a streamed delta (canvas) or a whole block (Claude). */
  onText(text: string): void
  /** A system note: tool activity, a result/cost summary, a warning. */
  onSystem(text: string): void
  /** Debug hook: the exact request sent to the model. Canvas engine only; others ignore it. */
  onRequest?(params: RunTurnParams, iteration: number): void
  /** Debug hook: an engine-specific diagnostic blob (e.g. Claude's raw structured output),
   *  shown only in debug mode. Set when debug is on; engines that have nothing skip it. */
  onDebug?(text: string): void
  /** The engine needs a user decision before it can continue this same conversation. */
  onQuestion?(question: AgentQuestion): void
  /** Provider-neutral activity suitable for a VSCode-style progress surface. */
  onActivity?(event: AgentActivityEvent): void
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
  /** Resume an in-flight native agent question without starting a new turn. */
  answerQuestion?(answer: AgentQuestionAnswer): Promise<void>
}
