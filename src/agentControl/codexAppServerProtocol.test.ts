import { describe, expect, it } from 'vitest'
import {
  codexActivityForItem,
  codexCommentaryEvent,
  codexCompletedTurnText,
  codexQuestionResult,
  codexReasoningText,
  parseCodexQuestion,
  parseCodexServerRequest,
} from './codexAppServerProtocol'

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

describe('Codex app-server activity and approvals', () => {
  it('maps command lifecycle items without exposing app-server fields to the UI', () => {
    expect(codexActivityForItem({
      id: 'cmd-1', type: 'commandExecution', status: 'completed',
      command: ['rg', '-n', 'cache', '.'], aggregatedOutput: '3 matches',
    })).toEqual({
      type: 'tool', id: 'cmd-1', name: 'Command', toolKind: 'command', status: 'completed',
      detail: 'rg -n cache .', output: '3 matches',
    })
  })

  it('reads only the public summary from a completed reasoning item', () => {
    expect(codexReasoningText({
      id: 'reason-1', type: 'reasoning', summary: ['Inspecting the repository'], content: ['hidden'],
    })).toBe('Inspecting the repository')
  })

  it('classifies public commentary by the provider phase', () => {
    expect(codexCommentaryEvent('message-1', 'commentary', 'Inspecting files')).toEqual({
      type: 'commentary_delta', id: 'message-1', delta: 'Inspecting files',
    })
    expect(codexCommentaryEvent(
      'message-2', 'final_answer', '{"reply":"done","operations":[]}',
    )).toBeNull()
  })

  it('maps command approval answers back to the documented decision shape', () => {
    const pending = parseCodexServerRequest(
      'approval-1',
      'item/commandExecution/requestApproval',
      { command: 'npm test', availableDecisions: ['accept', 'acceptForSession', 'decline'] },
    )
    expect(pending?.question.items[0].prompt).toContain('npm test')
    expect(pending?.result({ requestId: 'approval-1', answers: { decision: ['Always allow'] } }))
      .toEqual({ decision: 'acceptForSession' })
  })
})
