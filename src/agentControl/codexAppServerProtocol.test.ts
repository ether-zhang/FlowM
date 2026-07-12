import { describe, expect, it } from 'vitest'
import { codexCompletedTurnText, codexQuestionResult, parseCodexQuestion } from './codexAppServerProtocol'

describe('Codex app-server request_user_input mapping', () => {
  it('maps provider fields into the shared question contract', () => {
    expect(parseCodexQuestion('codex-1', {
      autoResolutionMs: 60_000,
      questions: [{
        id: 'layout',
        header: 'Layout',
        question: 'Choose a direction',
        isOther: true,
        options: [{ label: 'Vertical', description: 'Top to bottom' }],
      }],
    })).toEqual({
      requestId: 'codex-1',
      autoResolutionMs: 60_000,
      items: [{
        id: 'layout',
        header: 'Layout',
        prompt: 'Choose a direction',
        allowOther: true,
        secret: false,
        options: [{ label: 'Vertical', description: 'Top to bottom' }],
      }],
    })
  })

  it('maps shared answers back to the app-server response shape', () => {
    expect(codexQuestionResult({
      requestId: 'codex-1',
      answers: { layout: ['Vertical'] },
    })).toEqual({ answers: { layout: { answers: ['Vertical'] } } })
  })

  it('selects final_answer instead of structured commentary from a completed turn', () => {
    expect(codexCompletedTurnText({
      turn: {
        items: [
          { type: 'agentMessage', phase: 'commentary', text: '{"operations":[]}' },
          { type: 'commandExecution', command: ['read', 'guide'] },
          { type: 'agentMessage', phase: 'final_answer', text: '{"operations":[{"op":"create_geo"}]}' },
        ],
      },
    })).toBe('{"operations":[{"op":"create_geo"}]}')
  })
})
