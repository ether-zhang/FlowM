import { describe, it, expect } from 'vitest'
import { buildTurnPrompt, parseClaudeTurn, turnSchema } from './claudeAdapter'
import type { RunTurnParams } from '../llm'
import type { ToolDef } from '../protocol'

/* eslint-disable @typescript-eslint/no-explicit-any */
const tools: ToolDef[] = [
  { name: 'create_geo', description: 'make a box', parameters: { type: 'object', properties: {} } },
  { name: 'connect_shapes', description: 'arrow', parameters: { type: 'object', properties: {} } },
]

describe('turnSchema', () => {
  it('constrains output to operations[] with the tool enum drawn from the given tools', () => {
    const s = turnSchema(tools) as any
    expect(s.required).toContain('operations')
    expect(s.properties.operations.items.properties.tool.enum).toEqual(['create_geo', 'connect_shapes'])
  })
})

describe('buildTurnPrompt', () => {
  it('includes the system prompt, tool docs, serialized messages, and the image note', () => {
    const params: RunTurnParams = {
      system: 'SYS-PROMPT',
      messages: [{ role: 'user', content: 'Current canvas: ...\n---\n画个流程', image: 'data:...' }],
      tools,
    }
    const out = buildTurnPrompt(params, '.flowm/design.png')
    expect(out).toContain('SYS-PROMPT')
    expect(out).toContain('create_geo')
    expect(out).toContain('画个流程')
    expect(out).toContain('.flowm/design.png')
  })

  it('omits the image note when there is no render', () => {
    const out = buildTurnPrompt({ system: 'S', messages: [], tools }, null)
    expect(out).not.toContain('画布渲染图')
  })
})

describe('parseClaudeTurn', () => {
  it('maps operations to tool calls (with ids) and keeps the text', () => {
    const turn = parseClaudeTurn(
      { text: 'done', operations: [{ tool: 'create_geo', args: { x: 1, y: 2 } }, { tool: 'connect_shapes', args: { from: 'a', to: 'b' } }] },
      'fallback',
    )
    expect(turn.text).toBe('done')
    expect(turn.toolCalls.map((t) => t.name)).toEqual(['create_geo', 'connect_shapes'])
    expect(turn.toolCalls[0].args).toEqual({ x: 1, y: 2 })
    expect(turn.toolCalls[0].id).toBeTruthy()
  })

  it('falls back to streamed text and skips malformed operations (missing args → {})', () => {
    expect(parseClaudeTurn({ operations: [] }, 'streamed').text).toBe('streamed')
    const t = parseClaudeTurn({ operations: [{ no: 'tool' }, { tool: 'create_geo' }] }, '')
    expect(t.toolCalls.map((x) => x.name)).toEqual(['create_geo'])
    expect(t.toolCalls[0].args).toEqual({})
  })

  it('tolerates a null / empty structured output', () => {
    expect(parseClaudeTurn(null, 'x').toolCalls).toEqual([])
  })
})
