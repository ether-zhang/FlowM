import type { AgentQuestion, AgentQuestionAnswer } from './types'

interface ClaudeQuestionOption {
  label?: unknown
  description?: unknown
}

interface ClaudeQuestion {
  question?: unknown
  header?: unknown
  options?: unknown
  multiSelect?: unknown
}

export interface ClaudePendingQuestion {
  controlRequestId: string
  originalInput: Record<string, unknown>
  question: AgentQuestion
  promptsById: Record<string, string>
}

export function parseClaudeQuestion(
  requestId: string,
  controlRequestId: string,
  input: unknown,
): ClaudePendingQuestion | null {
  if (!input || typeof input !== 'object') return null
  const originalInput = input as Record<string, unknown>
  if (!Array.isArray(originalInput.questions)) return null
  const promptsById: Record<string, string> = {}
  const items = originalInput.questions.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return []
    const raw = value as ClaudeQuestion
    if (typeof raw.question !== 'string' || !raw.question.trim()) return []
    const id = `question-${index + 1}`
    const prompt = raw.question.trim()
    promptsById[id] = prompt
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return []
          const rawOption = option as ClaudeQuestionOption
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
      id,
      prompt,
      ...(typeof raw.header === 'string' && raw.header.trim() ? { header: raw.header.trim() } : {}),
      ...(options?.length ? { options } : {}),
      multiSelect: raw.multiSelect === true,
      allowOther: true,
    }]
  })
  if (items.length === 0) return null
  return {
    controlRequestId,
    originalInput,
    promptsById,
    question: { requestId, items },
  }
}

export function claudeQuestionUpdatedInput(
  pending: ClaudePendingQuestion,
  answer: AgentQuestionAnswer,
): Record<string, unknown> {
  const answers: Record<string, string | string[]> = {}
  for (const [id, values] of Object.entries(answer.answers)) {
    const prompt = pending.promptsById[id]
    if (!prompt || values.length === 0) continue
    answers[prompt] = values.length === 1 ? values[0] : values
  }
  return { ...pending.originalInput, answers }
}
