import { describe, it, expect } from 'vitest'
import { layoutDiagram } from './diagramLayout'
import type { DiagramSpec } from './diagram'

/* eslint-disable @typescript-eslint/no-explicit-any */
const spec: DiagramSpec = {
  nodes: [
    { id: 'a', label: 'Start', kind: 'terminal' },
    { id: 'b', label: 'Decide?', kind: 'decision' },
    { id: 'c', label: 'Do C' },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'b', to: 'zzz' }, // dangling — 'zzz' is not a node
  ],
}

const geos = (ops: any[]) => ops.filter((o) => o.op === 'create_geo')
const arrows = (ops: any[]) => ops.filter((o) => o.op === 'connect_shapes')

describe('layoutDiagram', () => {
  it('creates a geo per node (ref = id) and an arrow per VALID edge, dropping dangling ones', () => {
    const ops = layoutDiagram(spec, { x: 0, y: 0 }) as any[]
    expect(geos(ops).map((g) => g.ref)).toEqual(['a', 'b', 'c'])
    expect(arrows(ops)).toHaveLength(2)
    expect(arrows(ops).every((e) => e.from && e.to)).toBe(true)
  })

  it('maps node kinds to geo shapes (terminal→ellipse, decision→diamond, default→rectangle)', () => {
    const byRef = Object.fromEntries(geos(layoutDiagram(spec, { x: 0, y: 0 }) as any[]).map((o) => [o.ref, o.shape]))
    expect(byRef.a).toBe('ellipse')
    expect(byRef.b).toBe('diamond')
    expect(byRef.c).toBe('rectangle')
  })

  it('stacks the a→b→c chain downward (each layer lower than the last) by default', () => {
    const y = Object.fromEntries(geos(layoutDiagram(spec, { x: 0, y: 0 }) as any[]).map((o) => [o.ref, o.y]))
    expect(y.a).toBeLessThan(y.b)
    expect(y.b).toBeLessThan(y.c)
  })

  it('honours dir=right by advancing the chain along x instead', () => {
    const x = Object.fromEntries(geos(layoutDiagram({ ...spec, dir: 'right' }, { x: 0, y: 0 }) as any[]).map((o) => [o.ref, o.x]))
    expect(x.a).toBeLessThan(x.b)
    expect(x.b).toBeLessThan(x.c)
  })
})
