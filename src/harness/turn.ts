import type { AgentQuestionAnswer } from '../agent'
import { HarnessSession } from './session'
import { routeHarnessEvent } from './events'
import type { HarnessBinding, TurnReceipt } from './types'
import type { HarnessCallbacks } from './events'
import { inspectionRequest, runtimePolicy } from './execution'

export interface HarnessMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  image?: string
}
export interface HarnessTurnInput {
  phase: 'build' | 'review' | 'finalize'
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
  private disposed = false
  private cursorTurn: string | undefined
  private inspected = false
  private readonly binding: (system: string) => HarnessBinding
  private readonly createSession: (binding: HarnessBinding) => HarnessSession
  constructor(binding: Omit<HarnessBinding, 'system'> | ((system: string) => HarnessBinding),
    createSession?: (binding: HarnessBinding) => HarnessSession) {
    this.binding = typeof binding === 'function' ? binding : (system) => ({ ...binding, system })
    this.createSession = createSession ?? (() => new HarnessSession(() => this.binding(this.system!)))
  }

  async run(input: HarnessTurnInput, callbacks: HarnessCallbacks): Promise<HarnessTurnResult> {
    if (this.disposed) throw new Error('Harness turn is closed')
    const binding = this.binding(input.system)
    if (this.cursorTurn !== binding.userTurnId) { this.sent = 0; this.cancelled = false; this.inspected = false; this.cursorTurn = binding.userTurnId }
    if (this.cancelled) throw new Error('Harness turn was cancelled')
    if (!this.session) {
      this.system = input.system
      this.session = this.createSession(binding)
    } else if (this.system !== input.system) throw new Error('The system contract changed; open a new harness session')
    const delivered = input.messages.slice(this.sent)
    const prompt = delivered.filter((message) => message.role !== 'assistant').map((message) => message.content).join('\n\n')
    const images = delivered.flatMap((message) => message.role === 'user' && message.image ? [message.image] : [])
    if (input.phase === 'build' && !this.inspected) {
      await this.session.run(inspectionRequest(prompt), [], null,
        (event) => routeHarnessEvent(event, callbacks), runtimePolicy('inspect'))
      this.inspected = true
    }
    if (this.cancelled || this.disposed) throw new Error('Harness canvas workflow stopped before output')
    callbacks.onDebug?.(`FlowM harness · ${binding.role} · model: ${binding.model}\n${prompt}`)
    const receipt = await this.session.run(prompt, images, input.outputSchema, (event) => routeHarnessEvent(event, callbacks), runtimePolicy(input.phase))
    this.sent = input.messages.length
    callbacks.onDebug?.(`FlowM harness result · ${receipt.requestId}\n${receipt.text}`)
    return { receipt, delivered }
  }
  async answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    if (!this.session) throw new Error('Harness session has not started')
    await this.session.answer(answer)
  }
  async cancel(): Promise<void> { this.cancelled = true; await this.session?.cancel() }
  async dispose(): Promise<void> { this.disposed = true; this.cancelled = true; await this.session?.dispose() }
}
