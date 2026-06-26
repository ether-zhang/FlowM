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
