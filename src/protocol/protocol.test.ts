import { describe, it, expect } from 'vitest'
import { parseOp, type CanvasOp } from './schema'
import { formatCanvas } from './serialize'
import { canvasTools, toolCallToOp } from './tools'

describe('parseOp', () => {
  it('parses create_geo and applies w/h defaults', () => {
    const op = parseOp({ op: 'create_geo', shape: 'rectangle', x: 10, y: 20 })
    expect(op).toMatchObject({ op: 'create_geo', shape: 'rectangle', x: 10, y: 20, w: 120, h: 80 })
  })

  it('parses connect_shapes with refs', () => {
    const op = parseOp({ op: 'connect_shapes', from: 'a', to: 'b', text: 'yes' })
    expect(op.op).toBe('connect_shapes')
  })

  it('rejects an unknown op', () => {
    expect(() => parseOp({ op: 'teleport', x: 0 })).toThrow()
  })

  it('rejects create_geo with a bad shape kind', () => {
    expect(() => parseOp({ op: 'create_geo', shape: 'hexagon', x: 0, y: 0 })).toThrow()
  })

  it('rejects move_shape missing coordinates', () => {
    expect(() => parseOp({ op: 'move_shape', id: 'x' })).toThrow()
  })
})

describe('toolCallToOp + parseOp round-trip', () => {
  it('every tool name maps to a parseable op', () => {
    const samples: Record<string, Record<string, unknown>> = {
      create_geo: { shape: 'diamond', x: 0, y: 0 },
      create_text: { x: 0, y: 0, text: 'hi' },
      move_shape: { id: 'a', x: 1, y: 2 },
      update_text: { id: 'a', text: 'new' },
      delete_shape: { id: 'a' },
      connect_shapes: { from: 'a', to: 'b' },
    }
    for (const tool of canvasTools) {
      const input = samples[tool.name]
      expect(input, `sample for ${tool.name}`).toBeDefined()
      const op = parseOp(toolCallToOp(tool.name, input))
      expect((op as CanvasOp).op).toBe(tool.name)
    }
  })
})

describe('formatCanvas', () => {
  it('reports an empty canvas', () => {
    expect(formatCanvas([])).toBe('(canvas is empty)')
  })

  it('formats shapes compactly with rounded coords and text', () => {
    const out = formatCanvas([
      { id: 's1', type: 'rectangle', x: 10.4, y: 20.6, w: 120, h: 80, text: 'Start' },
      { id: 's2', type: 'text', x: 0, y: 0, text: 'note' },
    ])
    expect(out).toContain('#s1 rectangle @(10,21) 120x80 text="Start"')
    expect(out).toContain('#s2 text @(0,0) text="note"')
  })

  it('renders an arrow with its bound endpoints', () => {
    const out = formatCanvas([
      { id: 'a1', type: 'arrow', x: 0, y: 0, from: 's1', to: 's2', text: 'yes' },
    ])
    expect(out).toContain('#a1 arrow @(0,0) s1→s2 text="yes"')
  })

  it('prefixes only marked shapes; an unmarked arrow gets no [n]', () => {
    const out = formatCanvas(
      [
        { id: 's1', type: 'rectangle', x: 0, y: 0, w: 120, h: 80, text: 'A' },
        { id: 's2', type: 'ellipse', x: 0, y: 200, w: 120, h: 80, text: 'B' },
        { id: 'a1', type: 'arrow', x: 0, y: 0, from: 's1', to: 's2' },
      ],
      new Map([['s1', 1], ['s2', 2]]), // arrows aren't marked
    )
    expect(out).toContain('- [1] #s1 rectangle')
    expect(out).toContain('- [2] #s2 ellipse')
    expect(out).toContain('- #a1 arrow') // no [n] prefix
  })
})
