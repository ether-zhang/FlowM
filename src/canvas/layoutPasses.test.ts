import { describe, it, expect } from 'vitest'
import {
  runPasses,
  spacingPass,
  avoidPass,
  arrowPass,
  DEFAULT_PASSES,
  type PassContext,
  type LayoutPass,
} from './layoutPasses'

/** Minimal recording context so the passes can be exercised without Excalidraw. */
function stubCtx(over: Partial<PassContext> = {}): PassContext & { log: string[] } {
  const log: string[] = []
  return {
    log,
    createdCount: 0,
    boxes: () => (log.push('boxes'), []),
    edges: () => (log.push('edges'), []),
    structure: () => null,
    applyMoves: () => log.push('applyMoves'),
    arrowsToUpdate: () => (log.push('arrowsToUpdate'), []),
    updateArrow: () => log.push('updateArrow'),
    ...over,
  }
}

describe('runPasses', () => {
  it('runs passes in order', () => {
    const order: string[] = []
    const p = (name: string): LayoutPass => ({ name, kind: 'intent', run: () => order.push(name) })
    runPasses(stubCtx(), [p('a'), p('b'), p('c')])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('DEFAULT_PASSES is space → avoid → arrows', () => {
    expect(DEFAULT_PASSES.map((p) => p.name)).toEqual(['spacing', 'avoid', 'arrows'])
  })

  it('classifies node-moving passes as intent (B) and arrow-only as invariant (A)', () => {
    // see docs/structured-refine.md §1: only arrow geometry runs blind; node moves gate.
    expect(spacingPass.kind).toBe('intent')
    expect(avoidPass.kind).toBe('intent')
    expect(arrowPass.kind).toBe('invariant')
  })
})

describe('spacingPass', () => {
  it('skips when nothing was created (a pure move is not re-flowed)', () => {
    const ctx = stubCtx({ createdCount: 0 })
    spacingPass.run(ctx)
    expect(ctx.log).not.toContain('applyMoves')
  })

  it('runs when new shapes appear', () => {
    const ctx = stubCtx({ createdCount: 2 })
    spacingPass.run(ctx)
    expect(ctx.log).toContain('applyMoves')
  })
})

describe('avoidPass', () => {
  it('always applies the overlap resolution', () => {
    const ctx = stubCtx()
    avoidPass.run(ctx)
    expect(ctx.log).toContain('applyMoves')
  })
})

describe('arrowPass', () => {
  it('updates exactly the arrows the context reports', () => {
    const updated: string[] = []
    const ctx = stubCtx({ arrowsToUpdate: () => ['x', 'y'], updateArrow: (id) => updated.push(id) })
    arrowPass.run(ctx)
    expect(updated).toEqual(['x', 'y'])
  })
})

describe('scoped B passes (structure-driven)', () => {
  it('spacingPass flows only the nodes in the flow scope', () => {
    const boxes = [
      { id: 'a', x: 0, y: 0, w: 100, h: 60, movable: true },
      { id: 'b', x: 0, y: 300, w: 100, h: 60, movable: true },
      { id: 'c', x: 0, y: 600, w: 100, h: 60, movable: true }, // out of scope → frozen
    ]
    let moves = new Map<string, { x: number; y: number }>()
    const ctx = stubCtx({
      createdCount: 3,
      boxes: () => boxes,
      edges: () => [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
      structure: () => ({ spacing: new Set(['a', 'b']), overlap: new Set() }),
      applyMoves: (m) => { moves = m },
    })
    spacingPass.run(ctx)
    expect(moves.has('c')).toBe(false) // c isn't in the flow scope, so it never moves
  })

  it('avoidPass moves only nodes in the overlap scope, pinning the rest', () => {
    const boxes = [
      { id: 'a', x: 0, y: 0, w: 100, h: 100, movable: true }, // out of scope → frozen obstacle
      { id: 'b', x: 50, y: 50, w: 100, h: 100, movable: true }, // overlaps a; in scope → moves
    ]
    let moves = new Map<string, { x: number; y: number }>()
    const ctx = stubCtx({
      boxes: () => boxes,
      structure: () => ({ spacing: new Set(), overlap: new Set(['b']) }),
      applyMoves: (m) => { moves = m },
    })
    avoidPass.run(ctx)
    expect(moves.has('a')).toBe(false) // frozen
    expect(moves.has('b')).toBe(true) // shoved clear of a
  })

  it('falls back to global behaviour when structure() is null', () => {
    const boxes = [
      { id: 'a', x: 0, y: 0, w: 100, h: 100, movable: true },
      { id: 'b', x: 50, y: 50, w: 100, h: 100, movable: true },
    ]
    let moves = new Map<string, { x: number; y: number }>()
    const ctx = stubCtx({ boxes: () => boxes, structure: () => null, applyMoves: (m) => { moves = m } })
    avoidPass.run(ctx)
    expect(moves.size).toBeGreaterThan(0) // both movable, overlap resolved as today
  })
})
