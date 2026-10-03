import type { AgentQuestionAnswer } from '../agent'
import type { HarnessCallbacks } from '../harness'

/** What an engine reports back while producing a reply, mapped onto chat messages. */
export interface ChatCallbacks extends HarnessCallbacks {
  /** Assistant prose, streamed or returned by a completed harness turn. */
  onText(text: string, source?: 'model'): void
}

/**
 * A backend the chat can talk to through one uniform `send`. The canvas assistant
 * uses FlowM's canvas orchestration; the project role uses a workspace-write harness thread.
 */
export interface ChatEngine {
  /** Stable id used for selection. */
  readonly id: string
  /** Human label for the engine selector. */
  readonly label: string
  send(text: string, cb: ChatCallbacks): Promise<void>
  /** Resume an in-flight native agent question without starting a new turn. */
  answerQuestion?(answer: AgentQuestionAnswer): Promise<void>
  cancel?(): Promise<void>
}
