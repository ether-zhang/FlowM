import type { AgentQuestionAnswer } from '../agent'
import type { HarnessTurnPort } from '../harness'
import type { CanvasTurnRuntime, RunTurnParams, TurnCallbacks } from './canvasTurn'
import type { LlmTurn } from './types'
import { buildCanvasTurnOutputSchema, projectCanvasTurn } from './outputContract'

/** The canvas boundary owns schema/projection rules; the harness owns model delivery. */
export class CanvasTurnProjection implements CanvasTurnRuntime {
  private readonly turn: HarnessTurnPort
  constructor(turn: HarnessTurnPort) { this.turn = turn }
  async runTurn(params: RunTurnParams, callbacks: TurnCallbacks): Promise<LlmTurn> {
    const { receipt, delivered } = await this.turn.run({ phase: params.phase, system: params.system,
      messages: params.messages.map((message) => message.role === 'tool'
        ? { ...message, content: `Result of the previous operations: ${message.content}` } : message),
      outputSchema: buildCanvasTurnOutputSchema(params.tools, 'strict'),
    }, callbacks)
    const result = parseCanvasResult(receipt.text!, params, receipt.requestId)
    if (!result.text.trim() && !result.toolCalls.length && !result.question
      && (params.phase === 'finalize' || (params.phase === 'build' && !delivered.some((message) => message.role === 'tool')))) {
      throw new Error('The model returned no answer or canvas operations')
    }
    return result
  }
  answerQuestion(answer: AgentQuestionAnswer): Promise<void> { return this.turn.answerQuestion(answer) }
  cancel(): Promise<void> { return this.turn.cancel() }
  dispose(): Promise<void> { return this.turn.dispose() }
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
