import { describe, expect, it } from 'vitest'
import {
  claudeAssistantTextRole,
  claudePermissionResponse,
  claudeQuestionUpdatedInput,
  claudeToolActivity,
  parseClaudeAssistantContent,
  parseClaudePartialEvent,
  parseClaudePermission,
  parseClaudeQuestion,
  shouldAskClaudeToolPermission,
} from './claudeControlProtocol'

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

describe('Claude control activity and permissions', () => {
  it('preserves the native stop reason used to distinguish commentary from the final answer', () => {
    const final = parseClaudeAssistantContent({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Final explanation' }],
    })
    const commentary = parseClaudeAssistantContent({
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Inspecting the repository' }],
    })
    expect(final).toEqual({
      blocks: [{ type: 'text', text: 'Final explanation' }],
      stopReason: 'end_turn',
    })
    expect(claudeAssistantTextRole(final?.stopReason)).toBe('final')
    expect(claudeAssistantTextRole(commentary?.stopReason)).toBe('commentary')
  })

  it('maps partial block deltas and the later stop reason without assigning a text role early', () => {
    expect(parseClaudePartialEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'Inspecting' } },
    })).toEqual({ type: 'block_delta', index: 1, blockType: 'thinking', delta: 'Inspecting' })
    expect(parseClaudePartialEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
    })).toEqual({ type: 'block_delta', index: 0, blockType: 'text', delta: 'Done' })
    expect(parseClaudePartialEvent({
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    })).toEqual({ type: 'message_delta', stopReason: 'tool_use' })
  })

  it('maps tool calls to a compact lifecycle event', () => {
    expect(claudeToolActivity({
      type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' },
    })).toEqual({
      type: 'tool', id: 'tool-1', name: 'Bash', toolKind: 'command', status: 'running', detail: 'npm test',
    })
  })

  it('auto-allows known read-only tools and asks for commands', () => {
    expect(shouldAskClaudeToolPermission('Read')).toBe(false)
    expect(shouldAskClaudeToolPermission('Bash')).toBe(true)
    const pending = parseClaudePermission('permission-1', 'control-1', 'Bash', { command: 'npm test' })
    expect(pending.question.items[0].prompt).toContain('npm test')
    expect(claudePermissionResponse(pending, {
      requestId: 'permission-1', answers: { decision: ['Deny'] },
    })).toEqual({ behavior: 'deny', message: 'The user denied this tool call.' })
  })
})
