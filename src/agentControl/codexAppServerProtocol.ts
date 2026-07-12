import type { AgentQuestion, AgentQuestionAnswer } from './types'

export type JsonRpcId = string | number

export interface JsonRpcMessage {
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface RequestUserInputOption {
  label?: unknown
  description?: unknown
}

interface RequestUserInputQuestion {
  id?: unknown
  header?: unknown
  question?: unknown
  isOther?: unknown
  isSecret?: unknown
  options?: unknown
}

export function parseCodexQuestion(requestId: string, params: unknown): AgentQuestion | null {
  if (!params || typeof params !== 'object') return null
  const raw = params as { questions?: unknown; autoResolutionMs?: unknown }
  if (!Array.isArray(raw.questions)) return null
  const items = raw.questions.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return []
    const question = value as RequestUserInputQuestion
    if (typeof question.question !== 'string' || !question.question.trim()) return []
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return []
          const rawOption = option as RequestUserInputOption
          if (typeof rawOption.label !== 'string' || !rawOption.label.trim()) return []
          return [{
            label: rawOption.label.trim(),
            ...(typeof rawOption.description === 'string' && rawOption.description.trim()
              ? { description: rawOption.description.trim() }
              : {}),
          }]
        })
      : undefined
    return [{
      id: typeof question.id === 'string' && question.id ? question.id : `question-${index + 1}`,
      prompt: question.question.trim(),
      ...(typeof question.header === 'string' && question.header.trim()
        ? { header: question.header.trim() }
        : {}),
      ...(options?.length ? { options } : {}),
      allowOther: question.isOther === true || !options?.length,
      secret: question.isSecret === true,
    }]
  })
  if (items.length === 0) return null
  return {
    requestId,
    items,
    ...(typeof raw.autoResolutionMs === 'number' && Number.isFinite(raw.autoResolutionMs)
      ? { autoResolutionMs: raw.autoResolutionMs }
      : {}),
  }
}

export function codexQuestionResult(answer: AgentQuestionAnswer): { answers: Record<string, { answers: string[] }> } {
  return {
    answers: Object.fromEntries(
      Object.entries(answer.answers).map(([id, values]) => [id, { answers: values }]),
    ),
  }
}

/** Extract the terminal assistant message from a turn completion payload.
 * A turn may contain structured commentary before tool calls and a separate final answer. */
export function codexCompletedTurnText(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null
  const turn = (params as { turn?: unknown }).turn
  if (!turn || typeof turn !== 'object') return null
  const items = (turn as { items?: unknown }).items
  if (!Array.isArray(items)) return null

  const messages = items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as { type?: unknown; text?: unknown; phase?: unknown }
    if (record.type !== 'agentMessage' || typeof record.text !== 'string') return []
    return [{ text: record.text, phase: record.phase }]
  })
  const final = messages.findLast((message) => message.phase === 'final_answer')
  return final?.text ?? messages.at(-1)?.text ?? null
}
