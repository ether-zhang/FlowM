import type { AgentQuestionAnswer } from '../agent'
import { HarnessSession } from './session'
import { routeHarnessEvent } from './events'
import type { HarnessBinding, TurnReceipt } from './types'
import type { HarnessCallbacks } from './events'

export interface HarnessMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  image?: string
}
export interface HarnessTurnInput {
  system: string
  messages: readonly HarnessMessage[]
  outputSchema: unknown
}
export interface HarnessTurnResult {
  receipt: TurnReceipt
  delivered: readonly HarnessMessage[]
}
export interface HarnessTurnPort {
  run(input: HarnessTurnInput, callbacks: HarnessCallbacks): Promise<HarnessTurnResult>
  answerQuestion(answer: AgentQuestionAnswer): Promise<void>
  cancel(): Promise<void>
  dispose(): Promise<void>
}

/** Delivery and private model history belong to the harness; domain projections validate
 * the acknowledged result afterward, without resending already accepted input. */
export class HarnessTurn implements HarnessTurnPort {
  private session: HarnessSession | null = null
  private system: string | null = null
  private sent = 0
  private cancelled = false
  private readonly binding: Omit<HarnessBinding, 'system'>
  private readonly createSession: (binding: HarnessBinding) => HarnessSession
  constructor(binding: Omit<HarnessBinding, 'system'>,
    createSession = (binding: HarnessBinding) => new HarnessSession(binding)) {
    this.binding = binding
    this.createSession = createSession
  }

  async run(input: HarnessTurnInput, callbacks: HarnessCallbacks): Promise<HarnessTurnResult> {
    if (this.cancelled) throw new Error('Harness turn was cancelled; create a new FlowM conversation to continue')
    if (!this.session) {
      this.system = input.system
      this.session = this.createSession({ ...this.binding, system: input.system })
    } else if (this.system !== input.system) throw new Error('The system contract changed; open a new harness session')
    const delivered = input.messages.slice(this.sent)
    const prompt = delivered.filter((message) => message.role !== 'assistant').map((message) => message.content).join('\n\n')
    const images = delivered.flatMap((message) => message.role === 'user' && message.image ? [message.image] : [])
    callbacks.onDebug?.(`FlowM harness · ${this.binding.role} · model: ${this.binding.model}\n${prompt}`)
    const receipt = await this.session.run(prompt, images, input.outputSchema, (event) => routeHarnessEvent(event, callbacks))
    this.sent = input.messages.length
    callbacks.onDebug?.(`FlowM harness result · ${receipt.requestId}\n${receipt.text}`)
    return { receipt, delivered }
  }
  async answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    if (!this.session) throw new Error('Harness session has not started')
    await this.session.answer(answer)
  }
  async cancel(): Promise<void> { this.cancelled = true; await this.session?.cancel() }
  async dispose(): Promise<void> { this.cancelled = true; await this.session?.dispose() }
}
