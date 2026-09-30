import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PASSES,
  arrowPass,
  avoidPass,
  runPasses,
  spacingPass,
  type LayoutPass,
  type PassContext,
} from './layoutPasses'
import { compileLayoutPlan, type CompiledLayoutPlan, type LayoutSceneSnapshot } from './layoutPlan'

const node = (id: string, x: number, y: number, movable = true) => ({ id, x, y, w: 100, h: 60, movable })

function plan(overrides: Partial<LayoutSceneSnapshot> = {}): CompiledLayoutPlan {
  return compileLayoutPlan({
    nodes: [],
    edges: [],
    authorization: null,
    createdCount: 0,
    ...overrides,
  })
}

function stubCtx(current: CompiledLayoutPlan, overrides: Partial<PassContext> = {}): PassContext & { log: string[] } {
  const log: string[] = []
  return {
    log,
    plan: () => current,
    applyMoves: () => log.push('applyMoves'),
    routeArrows: () => log.push('routeArrows'),
    ...overrides,
  }
}

describe('runPasses', () => {
  it('runs passes in order', () => {
    const order: string[] = []
    const pass = (name: string): LayoutPass => ({ name, kind: 'intent', run: () => order.push(name) })
    runPasses(stubCtx(plan()), [pass('a'), pass('b'), pass('c')])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('settles node intent before routing invariants', () => {
    expect(DEFAULT_PASSES.map((pass) => pass.name)).toEqual(['spacing', 'avoid', 'arrows'])
    expect(spacingPass.kind).toBe('intent')
    expect(avoidPass.kind).toBe('intent')
    expect(arrowPass.kind).toBe('invariant')
  })
})

describe('compiled-plan passes', () => {
  it('does not run spacing without a compiled authorization or fresh nodes', () => {
    const ctx = stubCtx(plan({ nodes: [node('a', 0, 0), node('b', 0, 200)] }))
    spacingPass.run(ctx)
    expect(ctx.log).not.toContain('applyMoves')
  })

  it('applies authorized spacing and overlap plans', () => {
    const current = plan({
      nodes: [node('a', 0, 0), node('b', 20, 20)],
      edges: [{ id: 'e', from: 'a', to: 'b' }],
      authorization: { spacing: new Set(['a', 'b']), overlap: new Set(['b']), relations: [{ kind: 'flow', nodes: ['a', 'b'], dir: 'down' }] },
      createdCount: 2,
    })
    const ctx = stubCtx(current)
    spacingPass.run(ctx)
    avoidPass.run(ctx)
    expect(ctx.log.filter((entry) => entry === 'applyMoves')).toHaveLength(2)
  })

  it('routes the edge batch from the latest plan', () => {
    const first = plan({
      nodes: [node('a', 0, 0), node('b', 0, 200)],
      edges: [{ id: 'old', from: 'a', to: 'b' }],
      authorization: { spacing: new Set(['a', 'b']), overlap: new Set(['a', 'b']), relations: [{ kind: 'flow', nodes: ['a', 'b'], dir: 'down' }] },
      createdCount: 2,
    })
    const latest = plan({
      nodes: [node('a', 0, 0), node('b', 0, 260)],
      edges: [{ id: 'settled', from: 'a', to: 'b' }],
      createdCount: 2,
    })
    let reads = 0
    let routed: string[] = []
    const ctx = stubCtx(first, {
      plan: () => (reads++ === 0 ? first : latest),
      routeArrows: (edges) => { routed = edges.map((edge) => edge.id) },
    })
    spacingPass.run(ctx)
    arrowPass.run(ctx)
    expect(routed).toEqual(['settled'])
  })
})
