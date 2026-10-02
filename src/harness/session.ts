import type { AgentQuestionAnswer } from '../agent'
import { HarnessClient, harnessClient } from './client'
import type { HarnessBinding, HarnessEvent, TurnReceipt } from './types'

export class HarnessSession {
  private thread: string | null
  private opening: Promise<void> | null = null
  private inFlight: string | null = null
  private disposed = false
  private uncertain: string | null = null
  private initialContext: string
  private cancelled = false

  private readonly binding: HarnessBinding
  private readonly client: HarnessClient
  private readonly onOpened?: (id: string) => Promise<void>
  constructor(binding: HarnessBinding, client: HarnessClient = harnessClient, onOpened?: (id: string) => Promise<void>, initialContext = '') {
    this.binding = binding
    this.client = client
    this.onOpened = onOpened
    this.initialContext = initialContext
    this.thread = binding.threadId ?? null
  }
  get sessionId(): string | null { return this.thread }

  private async open(): Promise<void> {
    if (this.disposed) throw new Error('Harness session is closed')
    if (this.opening) return this.opening
    this.opening = this.client.openThread({ ...this.binding, ...(this.thread ? { threadId: this.thread } : {}) })
      .then(async (result) => { this.thread = result.threadId; await this.onOpened?.(result.threadId) })
      .finally(() => { this.opening = null })
    return this.opening
  }

  async run(prompt: string, images: string[], schema: unknown, onEvent: (event: HarnessEvent) => void): Promise<TurnReceipt> {
    if (this.cancelled) throw new Error('Harness session was cancelled; create a new FlowM conversation to continue')
    if (this.inFlight) throw new Error('This harness session is already busy')
    if (this.uncertain) throw new Error(`Request ${this.uncertain} did not settle. Inspect its effects and create a new FlowM conversation to continue.`)
    const requestId = crypto.randomUUID()
    this.inFlight = requestId
    try {
      await this.open()
      if (this.cancelled) throw new Error('Harness request cancelled before model submission')
      const input = this.initialContext ? `Historical FlowM conversation, retained for context. Do not replay completed actions:\n${this.initialContext}\n\nCurrent request:\n${prompt}` : prompt
      const receipt = await this.client.runTurn(this.thread!, requestId, input, images, schema, onEvent)
      this.initialContext = ''
      return receipt
    } catch (error) {
      // Only a confirmed completed receipt can recover the result. Never automatically resubmit.
      try {
        const receipt = await this.client.status(requestId)
        if (receipt.status === 'completed' && typeof receipt.text === 'string') { this.initialContext = ''; return receipt }
        if (['accepted', 'running', 'interrupted', 'uncertain'].includes(receipt.status)) this.uncertain = requestId
      } catch { this.uncertain = requestId }
      throw error
    } finally { this.inFlight = null }
  }

  async answer(answer: AgentQuestionAnswer): Promise<void> {
    if (!this.thread || !this.inFlight) throw new Error('This question is no longer active')
    await this.client.answer(this.thread, answer)
  }
  async cancel(): Promise<void> {
    this.cancelled = true
    if (this.thread && this.inFlight) await this.client.cancel(this.thread)
  }
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.opening) await this.opening.catch(() => {})
    if (this.thread) await this.client.closeThread(this.thread)
  }
}
