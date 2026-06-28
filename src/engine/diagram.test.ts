import { describe, it, expect } from 'vitest'
import { parseDiagram } from './diagram'

describe('parseDiagram', () => {
  it('accepts a valid nodes+edges spec and strips unknown keys', () => {
    const spec = parseDiagram({
      nodes: [{ id: 'a', label: 'A', kind: 'process' }, { id: 'b', label: 'B' }],
      edges: [{ from: 'a', to: 'b', label: 'x' }],
      extra: 1,
    })
    expect(spec).not.toBeNull()
    expect(spec!.nodes).toHaveLength(2)
    expect(spec!.edges[0]).toEqual({ from: 'a', to: 'b', label: 'x' })
    expect('extra' in (spec as Record<string, unknown>)).toBe(false)
  })

  it('rejects malformed input (missing id / missing edge end / non-object)', () => {
    expect(parseDiagram({ nodes: [{ label: 'no id' }], edges: [] })).toBeNull()
    expect(parseDiagram({ nodes: [], edges: [{ from: 'a' }] })).toBeNull()
    expect(parseDiagram(null)).toBeNull()
  })
})
