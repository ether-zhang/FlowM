import type { ToolDef } from '../protocol'
import type { AgentQuestionAnswer } from '../agent'
import type { HarnessCallbacks } from '../harness'
import type { LlmMessage, LlmTurn } from './types'

/** Callbacks fired while a turn is produced. */
export type TurnCallbacks = HarnessCallbacks

export interface RunTurnParams {
  phase: 'build' | 'review' | 'finalize'
  system: string
  messages: LlmMessage[]
  tools: ToolDef[]
}

/**
 * Keeps canvas turn orchestration independent of the model transport.
 * CanvasTurnProjection validates harness output at this domain boundary;
 * model connections, delivery cursors and credentials are owned by the harness.
 */
export interface CanvasTurnRuntime {
  /** Produce one assistant turn; resolve with its text and any tool calls. */
  runTurn(params: RunTurnParams, cb: TurnCallbacks): Promise<LlmTurn>
  /** Answer a harness question while its native turn remains in flight. */
  answerQuestion?(answer: AgentQuestionAnswer): Promise<void>
  /** Cancel the current model turn without replaying its input. */
  cancel?(): Promise<void>
  /** Release the private runtime session. */
  dispose?(): Promise<void>
}
