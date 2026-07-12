import { describe, expect, it } from 'vitest'
import { claudeQuestionUpdatedInput, parseClaudeQuestion } from './claudeControlProtocol'

describe('Claude Agent SDK AskUserQuestion mapping', () => {
  it('maps questions into the shared contract and answers back by prompt text', () => {
    const pending = parseClaudeQuestion('claude-1', 'control-1', {
      questions: [{
        question: 'Choose a layout',
        header: 'Layout',
        options: [{ label: 'Grid', description: 'Two columns' }],
        multiSelect: false,
      }],
    })
    expect(pending?.question).toEqual({
      requestId: 'claude-1',
      items: [{
        id: 'question-1',
        prompt: 'Choose a layout',
        header: 'Layout',
        options: [{ label: 'Grid', description: 'Two columns' }],
        multiSelect: false,
        allowOther: true,
      }],
    })
    expect(claudeQuestionUpdatedInput(pending!, {
      requestId: 'claude-1',
      answers: { 'question-1': ['Grid'] },
    })).toMatchObject({ answers: { 'Choose a layout': 'Grid' } })
  })
})
