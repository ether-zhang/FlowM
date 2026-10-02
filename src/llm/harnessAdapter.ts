import { HarnessSession, type HarnessBinding, type HarnessEvent } from '../harness'
import type { AgentQuestionAnswer } from '../agent'
import type { LlmAdapter, RunTurnParams, TurnCallbacks } from './adapter'
import type { LlmMessage, LlmTurn } from './types'
import { buildCanvasTurnOutputSchema, projectCanvasTurn } from './outputContract'

/** Canvas business turns cross the harness boundary; no CanvasPort or canvas tool runs here. */
export class HarnessAdapter implements LlmAdapter {
  private session: HarnessSession | null = null
  private sent = 0
  private turn = 0
  private cancelled = false

  private readonly binding: Omit<HarnessBinding, 'role' | 'system'>
  private readonly legacyContext: string
  private readonly createSession: (binding: HarnessBinding) => HarnessSession
  constructor(binding: Omit<HarnessBinding, 'role' | 'system'>, legacyContext = '', createSession = (binding: HarnessBinding) => new HarnessSession(binding)) {
    this.binding = binding
    this.legacyContext = legacyContext
    this.createSession = createSession
  }
  get sessionId(): string | null { return this.session?.sessionId ?? this.binding.threadId ?? null }

  async runTurn(params: RunTurnParams, cb: TurnCallbacks): Promise<LlmTurn> {
    if (this.cancelled) throw new Error('Canvas harness session was cancelled; create a new FlowM conversation to continue')
    if (!this.session) this.session = this.createSession({ ...this.binding, role: 'canvas', system: params.system })
    const fresh = params.messages.slice(this.sent)
    const { prompt, images } = composeCanvasDelta(fresh, this.sent === 0 ? this.legacyContext : '')
    const schema = buildCanvasTurnOutputSchema(params.tools, 'strict')
    cb.onDebug?.(`FlowM harness · ${params.phase} · read-only · model: ${this.binding.model}\n${prompt}`)
    const receipt = await this.session.run(prompt, images, schema, (event) => routeHarnessEvent(event, cb))
    // A completed request has consumed this input even when its structured output is invalid.
    // Keeping the delivery cursor separate from output validation avoids sending accepted input twice.
    this.sent = params.messages.length
    this.turn++
    const result = parseCanvasResult(receipt.text!, params, receipt.requestId)
    if (!result.text.trim() && !result.toolCalls.length && !result.question
      && (params.phase === 'finalize' || (params.phase === 'build' && !fresh.some((message) => message.role === 'tool')))) {
      throw new Error('The model returned no answer or canvas operations')
    }
    cb.onDebug?.(`FlowM harness result · turn ${this.turn}\n${receipt.text}`)
    return result
  }

  async answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    if (!this.session) throw new Error('Harness session has not started')
    await this.session.answer(answer)
  }
  async cancel(): Promise<void> { this.cancelled = true; await this.session?.cancel() }
  async dispose(): Promise<void> { await this.session?.dispose() }
}

export function composeCanvasDelta(messages: LlmMessage[], legacyContext = ''): { prompt: string; images: string[] } {
  const parts: string[] = []
  const images: string[] = []
  if (legacyContext) parts.push(`Earlier FlowM conversation, retained as historical context. Do not replay its completed operations:\n${legacyContext}`)
  for (const message of messages) {
    if (message.role === 'user') {
      parts.push(message.content)
      if (message.image) images.push(message.image)
    } else if (message.role === 'tool') {
      parts.push(`Result of the previous operations: ${message.content}`)
    }
  }
  return { prompt: parts.join('\n\n'), images }
}

export function parseCanvasResult(raw: string, params: RunTurnParams, requestId: string): LlmTurn {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('The model did not return valid canvas JSON; no operations from this response were applied') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid canvas response envelope')
  const envelope = value as Record<string, unknown>
  if (typeof envelope.reply !== 'string' || !Array.isArray(envelope.operations)
    || envelope.operations.some((operation) => !operation || typeof operation !== 'object' || typeof operation.op !== 'string')) {
    throw new Error('Incomplete canvas response; no operations from this response were applied')
  }
  if (params.phase === 'finalize' && envelope.operations.length) throw new Error('Canvas operations are forbidden during finalize')
  if (envelope.question != null && (typeof envelope.question !== 'object' || typeof (envelope.question as Record<string, unknown>).prompt !== 'string' || envelope.operations.length)) {
    throw new Error('A canvas question must have a prompt and no operations')
  }
  return projectCanvasTurn(value, { callIdPrefix: `harness-${requestId}` })
}

export function routeHarnessEvent(event: HarnessEvent, callbacks: TurnCallbacks): void {
  if (event.kind === 'activity') callbacks.onActivity?.(event.activity)
  else if (event.kind === 'question') callbacks.onQuestion?.(event.question)
  else if (event.kind === 'text') callbacks.onText?.(event.text)
}
