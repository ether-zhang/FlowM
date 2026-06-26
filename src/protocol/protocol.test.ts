import { describe, it, expect } from 'vitest'
import { parseOp, type CanvasOp } from './schema'
import { parseStructure } from './structure'
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

describe('parseStructure', () => {
  it('keeps valid relations and reports the malformed ones', () => {
    const { relations, errors } = parseStructure({
      relations: [
        { kind: 'flow', nodes: [1, 2, 3], dir: 'down' },
        { kind: 'contain', parent: 4, children: [5, 6] },
        { kind: 'flow', nodes: [1] }, // too few nodes → dropped
        { kind: 'wat', nodes: [1, 2] }, // unknown kind → dropped
      ],
    })
    expect(relations).toHaveLength(2)
    expect(relations[0]).toEqual({ kind: 'flow', nodes: [1, 2, 3], dir: 'down' })
    expect(relations[1]).toEqual({ kind: 'contain', parent: 4, children: [5, 6] })
    expect(errors).toHaveLength(2)
  })

  it('tolerates a missing/empty relations payload', () => {
    expect(parseStructure({}).relations).toEqual([])
    expect(parseStructure(null).relations).toEqual([])
    expect(parseStructure({ relations: [] }).relations).toEqual([])
  })

  it('validates each relation kind’s required fields', () => {
    const ok = parseStructure({
      relations: [
        { kind: 'align', nodes: [1, 2], axis: 'row' },
        { kind: 'grid', nodes: [1, 2, 3, 4], cols: 2 },
        { kind: 'nonOverlap', nodes: [7, 8] },
        { kind: 'freeze', nodes: [9] },
      ],
    })
    expect(ok.relations).toHaveLength(4)
    expect(ok.errors).toHaveLength(0)
    // bad field values are rejected
    expect(parseStructure({ relations: [{ kind: 'align', nodes: [1, 2], axis: 'diagonal' }] }).relations).toHaveLength(0)
    expect(parseStructure({ relations: [{ kind: 'grid', nodes: [1], cols: 0 }] }).relations).toHaveLength(0)
  })
})
