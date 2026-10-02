import type { AgentQuestionAnswer } from '../agent'
import { HarnessClient, HarnessNotSubmittedError, harnessClient } from './client'
import type { HarnessBinding, HarnessEvent, TurnReceipt } from './types'
import { routeHarnessEvent, type HarnessCallbacks } from './events'

export class HarnessSession {
  private thread: string | null
  private opening: Promise<void> | null = null
  private inFlight: string | null = null
  private disposed = false
  private uncertain: string | null = null
  private initialContext: string
  private cancelled = false
  private closing: Promise<void> | null = null

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

  private async open(): Promise<void> {
    if (this.disposed) throw new Error('Harness session is closed')
    if (this.opening) return this.opening
    this.opening = this.client.openThread({ ...this.binding, ...(this.thread ? { threadId: this.thread } : {}) })
      .then(async (result) => { this.thread = result.threadId; await this.onOpened?.(result.threadId) })
      .finally(() => { this.opening = null })
    return this.opening
  }

  async run(prompt: string, images: string[], schema: unknown, onEvent: (event: HarnessEvent) => void): Promise<TurnReceipt> {
    if (this.disposed) throw new Error('Harness session is closed')
    if (this.cancelled) throw new Error('Harness session was cancelled; create a new FlowM conversation to continue')
    if (this.inFlight) throw new Error('This harness session is already busy')
    if (this.uncertain) throw new Error(`Request ${this.uncertain} did not settle. Inspect its effects and create a new FlowM conversation to continue.`)
    const requestId = crypto.randomUUID()
    this.inFlight = requestId
    let submitted = false
    try {
      await this.open()
      if (this.cancelled || this.disposed) throw new Error('Harness request cancelled before model submission')
      const input = this.initialContext ? `Historical FlowM conversation, retained for context. Do not replay completed actions:\n${this.initialContext}\n\nCurrent request:\n${prompt}` : prompt
      submitted = true
      const receipt = await this.client.runTurn(this.thread!, requestId, input, images, schema, onEvent)
      this.initialContext = ''
      return receipt
    } catch (error) {
      if (!submitted || error instanceof HarnessNotSubmittedError) throw error
      // Only a confirmed completed receipt can recover the result. Never automatically resubmit.
      try {
        const receipt = await this.client.status(requestId)
        if (receipt.status === 'completed' && typeof receipt.text === 'string') { this.initialContext = ''; return receipt }
        if (['accepted', 'running', 'interrupted', 'uncertain'].includes(receipt.status)) this.uncertain = requestId
      } catch { this.uncertain = requestId }
      throw error
    } finally { this.inFlight = null }
  }

  async send(input: { prompt: string; images?: string[] }, callbacks: HarnessCallbacks): Promise<void> {
    let streamed = ''
    callbacks.onActivity?.({ type: 'status', status: 'working' })
    try {
      const result = await this.run(input.prompt, input.images ?? [], null, (event) => {
        if (event.kind === 'text') streamed += event.text
        routeHarnessEvent(event, callbacks)
      })
      if (result.text && !streamed.endsWith(result.text)) callbacks.onText?.(result.text.startsWith(streamed) ? result.text.slice(streamed.length) : result.text)
      callbacks.onActivity?.({ type: 'status', status: 'completed' })
    } catch (error) {
      callbacks.onActivity?.({ type: 'status', status: 'failed' })
      throw error
    }
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
    if (this.closing) return this.closing
    this.disposed = true
    this.cancelled = true
    this.closing = (async () => {
      if (this.opening) await this.opening.catch(() => {})
      if (this.thread) await this.client.closeThread(this.thread)
    })()
    return this.closing
  }
}
