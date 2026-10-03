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
  private cancelled = false
  private closing: Promise<void> | null = null
  private userTurn: string | undefined

  private readonly binding: () => HarnessBinding
  private readonly client: HarnessClient
  constructor(binding: HarnessBinding | (() => HarnessBinding), client: HarnessClient = harnessClient) {
    this.binding = typeof binding === 'function' ? binding : () => binding
    this.client = client
    this.thread = null
  }

  private async open(binding: HarnessBinding): Promise<void> {
    if (this.disposed) throw new Error('Harness session is closed')
    if (this.opening) return this.opening
    this.opening = this.client.openThread(binding)
      .then((result) => { this.thread = result.threadId })
      .finally(() => { this.opening = null })
    return this.opening
  }

  async run(prompt: string, images: string[], schema: unknown, onEvent: (event: HarnessEvent) => void): Promise<TurnReceipt> {
    if (this.disposed) throw new Error('Harness session is closed')
    const binding = this.binding()
    if (this.userTurn !== binding.userTurnId && !this.inFlight) {
      this.userTurn = binding.userTurnId
      this.cancelled = false
      this.uncertain = null
    }
    if (this.cancelled) throw new Error('Harness session was cancelled; create a new FlowM conversation to continue')
    if (this.inFlight) throw new Error('This harness session is already busy')
    if (this.uncertain) throw new Error(`Request ${this.uncertain} did not settle. Inspect its effects and create a new FlowM conversation to continue.`)
    const requestId = crypto.randomUUID()
    this.inFlight = requestId
    let submitted = false
    try {
      await this.open(binding)
      if (this.cancelled || this.disposed) throw new Error('Harness request cancelled before model submission')
      submitted = true
      const receipt = await this.client.runTurn(this.thread!, requestId, prompt, images, schema, onEvent, binding.userTurnId)
      return receipt
    } catch (error) {
      if (!submitted || error instanceof HarnessNotSubmittedError) throw error
      // Only a confirmed completed receipt can recover the result. Never automatically resubmit.
      try {
        const receipt = await this.client.status(requestId)
        if (receipt.status === 'completed' && typeof receipt.text === 'string') {
          if (binding.userTurnId) {
            const parent = await this.client.readSession(binding.projectRoot, binding.flowSessionId)
            if (parent.activeTurnId !== binding.userTurnId) throw new Error('The conversation request was interrupted; its model result remains in history', { cause: error })
          }
          return receipt
        }
        if (['accepted', 'running', 'interrupted', 'uncertain'].includes(receipt.status)) this.uncertain = requestId
      } catch { this.uncertain = requestId }
      throw error
    } finally { this.inFlight = null }
  }

  async send(input: { prompt: string; images?: string[] }, callbacks: HarnessCallbacks): Promise<void> {
    let streamed = ''
    callbacks.onActivity?.({ type: 'status', status: 'working' }, 'model')
    try {
      const result = await this.run(input.prompt, input.images ?? [], null, (event) => {
        if (event.kind === 'text') streamed += event.text
        routeHarnessEvent(event, callbacks)
      })
      if (result.text && !streamed.endsWith(result.text)) callbacks.onText?.(result.text.startsWith(streamed) ? result.text.slice(streamed.length) : result.text, 'model')
      callbacks.onActivity?.({ type: 'status', status: 'completed' }, 'model')
    } catch (error) {
      callbacks.onActivity?.({ type: 'status', status: 'failed' }, 'model')
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
