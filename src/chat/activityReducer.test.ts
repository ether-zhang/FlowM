import { describe, expect, it } from 'vitest'
import { createDisplayActivity, reduceActivity } from './activityReducer'

describe('chat activity reducer', () => {
  it('merges streamed thinking and commentary by provider item id', () => {
    let state = createDisplayActivity()
    state = reduceActivity(state, { type: 'thinking_delta', id: 'r1', delta: 'Inspecting ' })
    state = reduceActivity(state, { type: 'thinking_delta', id: 'r1', delta: 'the repo' })
    state = reduceActivity(state, { type: 'commentary_delta', id: 'm1', delta: 'I found it.' })
    expect(state.thinking.r1).toBe('Inspecting the repo')
    expect(state.commentary.m1).toBe('I found it.')
    expect(state.timeline).toEqual([
      { kind: 'thinking', id: 'r1' },
      { kind: 'commentary', id: 'm1' },
    ])
  })

  it('updates a tool in place through its lifecycle', () => {
    let state = reduceActivity(createDisplayActivity(), {
      type: 'tool', id: 'tool-1', name: 'Bash', toolKind: 'command', detail: 'npm test', status: 'running',
    })
    state = reduceActivity(state, {
      type: 'tool_status', id: 'tool-1', status: 'completed', output: '42 tests passed',
    })
    expect(state.tools).toEqual([{
      id: 'tool-1', name: 'Bash', toolKind: 'command', detail: 'npm test', status: 'completed', output: '42 tests passed',
    }])
  })

  it('starts a new text segment when the same provider id resumes after a tool', () => {
    let state = reduceActivity(createDisplayActivity(), {
      type: 'commentary_delta', id: 'claude-commentary', delta: 'Before tools',
    })
    state = reduceActivity(state, {
      type: 'tool', id: 'read-1', name: 'Read', status: 'completed', detail: 'src/app.ts',
    })
    state = reduceActivity(state, {
      type: 'commentary_delta', id: 'claude-commentary', delta: 'After tools',
    })

    expect(state.commentary).toEqual({
      'claude-commentary': 'Before tools',
      'claude-commentary:2': 'After tools',
    })
    expect(state.timeline).toEqual([
      { kind: 'commentary', id: 'claude-commentary' },
      { kind: 'tool', id: 'read-1' },
      { kind: 'commentary', id: 'claude-commentary:2', sourceId: 'claude-commentary' },
    ])
  })

  it('settles running tools when their parent turn reaches a terminal state', () => {
    let state = reduceActivity(createDisplayActivity(), {
      type: 'tool', id: 'running', name: 'Read', status: 'running',
    })
    state = reduceActivity(state, {
      type: 'tool', id: 'failed', name: 'Grep', status: 'failed',
    })
    state = reduceActivity(state, { type: 'status', status: 'completed' })

    expect(state.tools.map((tool) => tool.status)).toEqual(['completed', 'failed'])
  })

  it('folds repeated stderr into one warning detail', () => {
    let state = reduceActivity(createDisplayActivity(), {
      type: 'warning', id: 'stderr', text: 'Agent diagnostics', detail: 'first',
    })
    state = reduceActivity(state, {
      type: 'warning', id: 'stderr', text: 'Agent diagnostics', detail: 'second',
    })
    expect(state.warnings).toEqual([{
      id: 'stderr', text: 'Agent diagnostics', detail: 'first\nsecond',
    }])
  })
})
