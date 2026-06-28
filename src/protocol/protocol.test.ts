import { describe, it, expect } from 'vitest'
import { parseOp, type CanvasOp } from './schema'
import { parseStructure, resolveScope } from './structure'
import { formatCanvas } from './serialize'
import { canvasTools, toolCallToOp } from './tools'

describe('parseOp', () => {
  it('parses create_geo and leaves omitted w/h undefined (the port supplies a default)', () => {
    const op = parseOp({ op: 'create_geo', shape: 'rectangle', x: 10, y: 20 })
    expect(op).toMatchObject({ op: 'create_geo', shape: 'rectangle', x: 10, y: 20 })
    expect((op as { w?: number }).w).toBeUndefined()
    expect((op as { h?: number }).h).toBeUndefined()
  })

  it('keeps explicit create_geo w/h (model-given size is intent)', () => {
    const op = parseOp({ op: 'create_geo', shape: 'rectangle', x: 0, y: 0, w: 189, h: 26 })
    expect(op).toMatchObject({ w: 189, h: 26 })
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

  it('folds freedraw strokes into one hand-drawn region (union bbox + count)', () => {
    const out = formatCanvas([
      { id: 'd1', type: 'draw', x: 10, y: 10, w: 40, h: 20 },
      { id: 'd2', type: 'draw', x: 30, y: 40, w: 50, h: 30 },
      { id: 'r1', type: 'rectangle', x: 200, y: 0, w: 120, h: 80, text: 'C' },
    ])
    // The rectangle stays itemised; the two strokes collapse to one region line.
    expect(out).toContain('#r1 rectangle')
    expect(out).not.toContain('#d1')
    expect(out).not.toContain('#d2')
    expect(out).toContain('hand-drawn region @(10,10) 70x60 — 2 freehand strokes')
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
        { kind: 'flow', nodes: ['a', 'b', 'c'], dir: 'down' },
        { kind: 'contain', parent: 'p', children: ['x', 'y'] },
        { kind: 'flow', nodes: ['a'] }, // too few nodes → dropped
        { kind: 'wat', nodes: ['a', 'b'] }, // unknown kind → dropped
      ],
    })
    expect(relations).toHaveLength(2)
    expect(relations[0]).toEqual({ kind: 'flow', nodes: ['a', 'b', 'c'], dir: 'down' })
    expect(relations[1]).toEqual({ kind: 'contain', parent: 'p', children: ['x', 'y'] })
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
        { kind: 'align', nodes: ['a', 'b'], axis: 'row' },
        { kind: 'grid', nodes: ['a', 'b', 'c', 'd'], cols: 2 },
        { kind: 'nonOverlap', nodes: ['g', 'h'] },
        { kind: 'freeze', nodes: ['i'] },
      ],
    })
    expect(ok.relations).toHaveLength(4)
    expect(ok.errors).toHaveLength(0)
    // bad field values are rejected
    expect(parseStructure({ relations: [{ kind: 'align', nodes: ['a', 'b'], axis: 'diagonal' }] }).relations).toHaveLength(0)
    expect(parseStructure({ relations: [{ kind: 'grid', nodes: ['a'], cols: 0 }] }).relations).toHaveLength(0)
    expect(parseStructure({ relations: [{ kind: 'flow', nodes: [1, 2] }] }).relations).toHaveLength(0) // ids are strings
  })
})

describe('resolveScope', () => {
  it('flow nodes get spacing + overlap; nonOverlap nodes get overlap only', () => {
    const scope = resolveScope([
      { kind: 'flow', nodes: ['id1', 'id2', 'id3'] },
      { kind: 'nonOverlap', nodes: ['id4', 'id5'] },
    ])
    expect([...scope.spacing].sort()).toEqual(['id1', 'id2', 'id3'])
    expect([...scope.overlap].sort()).toEqual(['id1', 'id2', 'id3', 'id4', 'id5'])
  })

  it('relations with no realiser yet (align/grid/contain/freeze) contribute nothing', () => {
    const scope = resolveScope([
      { kind: 'align', nodes: ['a', 'b'], axis: 'row' },
      { kind: 'grid', nodes: ['a', 'b', 'c', 'd'], cols: 2 },
      { kind: 'freeze', nodes: ['e'] },
    ])
    expect(scope.spacing.size).toBe(0)
    expect(scope.overlap.size).toBe(0)
  })
})
