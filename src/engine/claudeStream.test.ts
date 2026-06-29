import { describe, it, expect } from 'vitest'
import { interpretClaudeLine, extractStructured } from './claudeStream'

describe('interpretClaudeLine', () => {
  it('maps an init event to a system note with model + cwd', () => {
    const out = interpretClaudeLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8', cwd: 'D:/p' }))
    expect(out).toEqual([{ kind: 'system', text: '▶ Claude Code · claude-opus-4-8 · D:/p' }])
  })

  it('maps assistant text to a text item and a tool_use to a system note with a short hint', () => {
    expect(interpretClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }))).toEqual([
      { kind: 'text', text: 'hi' },
    ])
    expect(
      interpretClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } })),
    ).toEqual([{ kind: 'system', text: '🔧 Bash: ls -la' }])
  })

  it('drops thinking blocks', () => {
    expect(interpretClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '...' }] } }))).toEqual([])
  })

  it('collapses a tool_result to a compact marker (never the full content)', () => {
    const out = interpretClaudeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'a huge dump'.repeat(999) }] } }))
    expect(out).toEqual([{ kind: 'system', text: '  ↳ 工具完成' }])
  })

  it('summarises the result with turns and cost', () => {
    const out = interpretClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.150387 }))
    expect(out).toEqual([{ kind: 'system', text: '✓ 完成 · 2 轮 · $0.150' }])
  })

  it('tolerates non-JSON / unknown events', () => {
    expect(interpretClaudeLine('not json')).toEqual([])
    expect(interpretClaudeLine(JSON.stringify({ type: 'rate_limit_event' }))).toEqual([])
  })

  it('suppresses the internal StructuredOutput tool from the chat (draw-mode plumbing)', () => {
    expect(
      interpretClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { nodes: [] } }] } })),
    ).toEqual([])
  })
})

describe('extractStructured', () => {
  it('returns the structured_output object from a result event', () => {
    expect(extractStructured(JSON.stringify({ type: 'result', structured_output: { nodes: [{ id: 'a' }] } }))).toEqual({ nodes: [{ id: 'a' }] })
  })

  it('returns null for non-result lines, results without it, and noise', () => {
    expect(extractStructured(JSON.stringify({ type: 'assistant', message: {} }))).toBeNull()
    expect(extractStructured(JSON.stringify({ type: 'result', num_turns: 1 }))).toBeNull()
    expect(extractStructured('not json')).toBeNull()
  })
})
