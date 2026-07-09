import type { LlmQuestion } from './types'

export function normalizeLlmQuestion(value: unknown): LlmQuestion | undefined {
  if (!value || typeof value !== 'object') return undefined
  const prompt = (value as { prompt?: unknown }).prompt
  if (typeof prompt !== 'string') return undefined
  const trimmed = prompt.trim()
  return trimmed ? { prompt: trimmed } : undefined
}
