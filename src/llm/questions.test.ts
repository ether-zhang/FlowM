import { describe, expect, it } from 'vitest'
import { normalizeLlmQuestion } from './questions'

describe('normalizeLlmQuestion', () => {
  it('accepts a non-empty prompt', () => {
    expect(normalizeLlmQuestion({ prompt: ' Continue with this plan? ' })).toEqual({
      prompt: 'Continue with this plan?',
    })
  })

  it('drops missing or empty prompts', () => {
    expect(normalizeLlmQuestion(null)).toBeUndefined()
    expect(normalizeLlmQuestion({ prompt: '' })).toBeUndefined()
    expect(normalizeLlmQuestion({ prompt: 123 })).toBeUndefined()
  })
})
