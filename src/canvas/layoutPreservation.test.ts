import { describe, expect, it } from 'vitest'
import { resolveScope, type StructureRelation } from '../protocol'
import { resolveOverlaps } from './layout'
import { compileLayoutPlan, type LayoutNodeSnapshot } from './layoutPlan'
import { boxContains, captureLayoutPreservation, expandFlowSpacing, protectLayoutMoves, remainingLayoutConflicts } from './layoutPreservation'

const node = (id: string, x: number, y: number, movable = true): LayoutNodeSnapshot => ({ id, x, y, w: 100, h: 60, movable })
const apply = (nodes: readonly LayoutNodeSnapshot[], moves: Map<string, { x: number; y: number }>) =>
  nodes.map((item) => ({ ...item, ...(moves.get(item.id) ?? {}) }))

describe('composition-preserving layout repair', () => {
  it('moves an aligned row together instead of pushing its middle node off the row', () => {
    const nodes = [node('a', 0, 0), node('b', 200, 0), node('c', 400, 0), { ...node('obstacle', 220, 40, false), w: 60 }]
    const preservation = captureLayoutPreservation(nodes)
    const proposal = resolveOverlaps(nodes)
    expect(proposal.get('b')?.y).toBe(-36)
    const repair = protectLayoutMoves(nodes, proposal, preservation)
    const after = apply(nodes, repair.moves)
    expect(repair.issues).toEqual([])
    expect(after.slice(0, 3).map((item) => item.y)).toEqual([-36, -36, -36])
    expect(after.slice(0, 3).map((item) => item.x)).toEqual([0, 200, 400])
    expect(after[3]).toEqual(nodes[3])
  })

  it('rejects the row movement when an aligned context node is frozen', () => {
    const nodes = [node('a', 0, 0, false), node('b', 200, 0), node('c', 400, 0), { ...node('obstacle', 220, 40, false), w: 60 }]
    const preservation = captureLayoutPreservation(nodes)
    const repair = protectLayoutMoves(nodes, resolveOverlaps(nodes), preservation)
    expect(repair.moves.size).toBe(0)
    expect(repair.issues.join(' ')).toContain('context-only shape a')
    expect(remainingLayoutConflicts(nodes, preservation, []).join(' ')).toContain('Unresolved overlap: b, obstacle')
  })

  it('recognizes existing containment as legal instead of ejecting the child', () => {
    const parent = { ...node('parent', 0, 0, false), w: 600, h: 300, containerCandidate: true }
    const child = node('child', 40, 60)
    const nodes = [parent, child]
    const preservation = captureLayoutPreservation(nodes)
    const moves = resolveOverlaps(nodes, { ignorePairs: preservation.ignoredOverlaps })
    expect(moves.size).toBe(0)
    expect(boxContains(parent, child)).toBe(true)
    expect(remainingLayoutConflicts(nodes, preservation, [])).toEqual([])
  })

  it('refuses to expand a flow out of its fixed-size parent and reports the missing space', () => {
    const nodes = [
      { ...node('parent', 0, 0, false), w: 200, h: 180, containerCandidate: true },
      node('a', 40, 20), node('b', 40, 100),
    ]
    const plan = compileLayoutPlan({
      nodes, edges: [{ id: 'ab', from: 'a', to: 'b' }], createdCount: 0,
      authorization: resolveScope([{ kind: 'flow', nodes: ['a', 'b'], dir: 'down' }]),
    })
    const repair = protectLayoutMoves(nodes, expandFlowSpacing(plan.intent.spacing.nodes, plan.intent.spacing.edges), plan.preservation, plan.intent.spacing.edges)
    expect(repair.moves.size).toBe(0)
    expect(repair.issues.join(' ')).toContain('Container parent cannot accommodate b')
    expect(remainingLayoutConflicts(nodes, plan.preservation, plan.intent.spacing.edges).join(' ')).toContain('needs 72px')
  })

  it('adds only missing vertical space while keeping existing columns and larger gaps', () => {
    const nodes = [node('a', 0, 0), node('b', 0, 80), node('c', 0, 400)]
    const plan = compileLayoutPlan({
      nodes, edges: [{ id: 'ab', from: 'a', to: 'b' }, { id: 'bc', from: 'b', to: 'c' }], createdCount: 0,
      authorization: resolveScope([{ kind: 'flow', nodes: ['a', 'b', 'c'], dir: 'down' }]),
    })
    const repair = protectLayoutMoves(nodes, expandFlowSpacing(plan.intent.spacing.nodes, plan.intent.spacing.edges), plan.preservation, plan.intent.spacing.edges)
    const after = apply(nodes, repair.moves)
    expect(repair.issues).toEqual([])
    expect(after.map((item) => item.x)).toEqual([0, 0, 0])
    expect(after.map((item) => item.y)).toEqual([0, 132, 400])
  })

  it('keeps a frozen flow source as an anchor without discarding its spacing constraint', () => {
    const nodes = [node('a', 0, 0, false), node('b', 0, 80)]
    const plan = compileLayoutPlan({
      nodes, edges: [{ id: 'ab', from: 'a', to: 'b' }], createdCount: 0,
      authorization: resolveScope([
        { kind: 'flow', nodes: ['a', 'b'], dir: 'down' }, { kind: 'freeze', nodes: ['a'] },
      ]),
    })
    const repair = protectLayoutMoves(nodes, expandFlowSpacing(plan.intent.spacing.nodes, plan.intent.spacing.edges), plan.preservation, plan.intent.spacing.edges)
    expect(repair.issues).toEqual([])
    expect(repair.moves.has('a')).toBe(false)
    expect(repair.moves.get('b')).toEqual({ x: 0, y: 132 })
  })

  it('does not let cross-region dependencies or UUID order choose the flow parent', () => {
    const repaired = (left: string, right: string) => {
      const nodes = [node(left, 0, 0), node('bottom-left', 0, 80), node(right, 300, 0), node('bottom-right', 300, 80)]
      const relations: StructureRelation[] = [
        { kind: 'flow', nodes: [left, 'bottom-left'], dir: 'down' },
        { kind: 'flow', nodes: [right, 'bottom-right'], dir: 'down' },
      ]
      const plan = compileLayoutPlan({
        nodes, createdCount: 0, authorization: resolveScope(relations),
        edges: [{ id: 'left', from: left, to: 'bottom-left' }, { id: 'right', from: right, to: 'bottom-right' }, { id: 'dependency', from: right, to: 'bottom-left' }],
      })
      expect(plan.intent.spacing.edges.map((edge) => edge.id)).not.toContain('dependency')
      const repair = protectLayoutMoves(nodes, expandFlowSpacing(plan.intent.spacing.nodes, plan.intent.spacing.edges), plan.preservation, plan.intent.spacing.edges)
      expect(repair.issues).toEqual([])
      return apply(nodes, repair.moves).map(({ x, y }) => ({ x, y }))
    }
    expect(repaired('a', 'z')).toEqual(repaired('z', 'a'))
    expect(repaired('a', 'z')).toEqual([{ x: 0, y: 0 }, { x: 0, y: 132 }, { x: 300, y: 0 }, { x: 300, y: 132 }])
  })

  it('translates children along with their moving container', () => {
    const nodes = [{ ...node('parent', 0, 0), w: 600, h: 300, containerCandidate: true }, node('child', 40, 60)]
    const repair = protectLayoutMoves(nodes, new Map([['parent', { x: 100, y: 50 }]]), captureLayoutPreservation(nodes))
    expect(repair.issues).toEqual([])
    expect(repair.moves.get('child')).toEqual({ x: 140, y: 110 })
  })

  it('rejects a collision fix that makes a previously adequate flow connector too short', () => {
    const nodes = [node('a', 0, 0), node('b', 0, 160)]
    const plan = compileLayoutPlan({
      nodes, edges: [{ id: 'ab', from: 'a', to: 'b' }], createdCount: 0,
      authorization: resolveScope([{ kind: 'flow', nodes: ['a', 'b'], dir: 'down' }]),
    })
    const repair = protectLayoutMoves(nodes, new Map([['b', { x: 0, y: 100 }]]), plan.preservation, plan.intent.spacing.edges)
    expect(repair.moves.size).toBe(0)
    expect(repair.issues.join(' ')).toContain('shorten the connector corridor')
  })

  it('rejects new collisions and reversals instead of silently accepting them', () => {
    const nodes = [node('a', 0, 0), node('b', 200, 0)]
    const preservation = captureLayoutPreservation(nodes)
    expect(protectLayoutMoves(nodes, new Map([['b', { x: 50, y: 0 }]]), preservation).issues.join(' ')).toContain('overlap')
    expect(protectLayoutMoves(nodes, new Map([['b', { x: -200, y: 0 }]]), preservation).issues.join(' ')).toContain('reverse')
  })
})
