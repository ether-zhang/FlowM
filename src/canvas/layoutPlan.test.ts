import { describe, expect, it } from 'vitest'
import { compileLayoutPlan } from './layoutPlan'

const node = (id: string, x: number, y: number, movable = true) => ({ id, x, y, w: 100, h: 60, movable })

describe('compileLayoutPlan', () => {
  it('keeps LayoutScope as a movement boundary', () => {
    const plan = compileLayoutPlan({
      nodes: [node('a', 0, 0), node('b', 0, 160), node('context', 220, 0)],
      edges: [{ id: 'flow', from: 'a', to: 'b' }, { id: 'cross', from: 'b', to: 'context' }],
      authorization: { spacing: new Set(['a', 'b']), overlap: new Set(['b']), relations: [{ kind: 'flow', nodes: ['a', 'b'], dir: 'down' }] },
      createdCount: 2,
    })

    expect(plan.intent.spacing.nodes.map((item) => item.id)).toEqual(['a', 'b'])
    expect(plan.intent.spacing.edges.map((edge) => edge.id)).toEqual(['flow'])
    expect(plan.intent.overlap.nodes.find((item) => item.id === 'a')?.movable).toBe(false)
    expect(plan.intent.overlap.nodes.find((item) => item.id === 'b')?.movable).toBe(true)
    expect(plan.intent.overlap.nodes.find((item) => item.id === 'context')?.movable).toBe(false)
  })

  it('raises the corridor floor when several edges share one side', () => {
    const plan = compileLayoutPlan({
      nodes: [node('a', 0, 100), node('b', 300, 0), node('c', 300, 100), node('d', 300, 200)],
      edges: [
        { id: 'ab', from: 'a', to: 'b' },
        { id: 'ac', from: 'a', to: 'c' },
        { id: 'ad', from: 'a', to: 'd' },
      ],
      authorization: { spacing: new Set(['a', 'b', 'c', 'd']), overlap: new Set(), relations: [
        { kind: 'flow', nodes: ['a', 'b'], dir: 'right' },
        { kind: 'flow', nodes: ['a', 'c'], dir: 'right' },
        { kind: 'flow', nodes: ['a', 'd'], dir: 'right' },
      ] },
      createdCount: 4,
    })

    expect(plan.intent.spacing.minimumGap).toBe(72)
    expect(plan.intent.spacing.edges.every((edge) => edge.minGap > plan.intent.spacing.minimumGap)).toBe(true)
  })

  it('routes labeled edges first and compiles stable endpoint focus', () => {
    const plan = compileLayoutPlan({
      nodes: [node('a', 0, 100), node('b', 300, 0), node('c', 300, 100), node('d', 300, 200)],
      edges: [
        { id: 'plain', from: 'a', to: 'b' },
        { id: 'labeled', from: 'a', to: 'c', label: { id: 'label', w: 90, h: 24 } },
        { id: 'other', from: 'a', to: 'd' },
      ],
      authorization: null,
      createdCount: 3,
    })

    expect(plan.routing.edges[0].id).toBe('labeled')
    expect(new Set(plan.routing.edges.map((edge) => edge.focus.start)).size).toBeGreaterThan(1)
  })

  it('separates parallel and reverse edges in the compiled route plan', () => {
    const plan = compileLayoutPlan({
      nodes: [node('a', 0, 0), node('b', 300, 0)],
      edges: [
        { id: 'forward', from: 'a', to: 'b' },
        { id: 'back', from: 'b', to: 'a' },
      ],
      authorization: null,
      createdCount: 0,
    })
    const offsets = new Map(plan.routing.edges.map((edge) => [edge.id, edge.offset]))
    expect(offsets.get('forward')).not.toBe(0)
    expect(offsets.get('back')).not.toBe(0)
    expect(Math.sign(offsets.get('forward')!)).toBe(Math.sign(offsets.get('back')!))
  })

  it('treats an endpoint ancestor container as a pass-through boundary', () => {
    const plan = compileLayoutPlan({
      nodes: [
        { id: 'region', x: 200, y: 0, w: 500, h: 400, movable: false, containerCandidate: true },
        node('outside', 0, 150),
        node('inside', 350, 150),
        node('unrelated', 800, 150),
      ],
      edges: [
        { id: 'into-region', from: 'outside', to: 'inside' },
        { id: 'past-region', from: 'outside', to: 'unrelated' },
      ],
      authorization: null,
      createdCount: 0,
    })

    const into = plan.routing.edges.find((edge) => edge.id === 'into-region')!
    const past = plan.routing.edges.find((edge) => edge.id === 'past-region')!
    expect(into.transparentObstacleIds).toContain('region')
    expect(past.transparentObstacleIds).not.toContain('region')
  })
})
