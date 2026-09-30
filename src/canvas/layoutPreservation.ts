import type { StructureRelation } from '../protocol'
import type { Pt } from './bindingGeometry'
import type { LayoutBox } from './layout'
import type { LayoutNodeSnapshot, PlannedSpacingEdge } from './layoutPlan'

const EPSILON = 0.01
const ALIGN_TOLERANCE = 2
type Axis = 'x' | 'y'

export interface LayoutPreservation {
  /** Equal translations retain existing alignments; they never grant movement. */
  groups: Record<Axis, string[][]>
  containers: Array<{ parent: string; child: string }>
  order: Array<{ before: string; after: string; axis: Axis }>
  ignoredOverlaps: ReadonlySet<string>
}

export const overlapPairKey = (a: string, b: string): string => JSON.stringify(a < b ? [a, b] : [b, a])
const extent = (node: LayoutBox, axis: Axis): number => axis === 'x' ? node.w : node.h
const center = (node: LayoutBox, axis: Axis): number => node[axis] + extent(node, axis) / 2

export function boxContains(parent: LayoutBox, child: LayoutBox, tolerance = ALIGN_TOLERANCE): boolean {
  return child.x >= parent.x - tolerance && child.y >= parent.y - tolerance
    && child.x + child.w <= parent.x + parent.w + tolerance
    && child.y + child.h <= parent.y + parent.h + tolerance
}

function overlapArea(a: LayoutBox, b: LayoutBox): number {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
}

/** Capture what must survive a repair, separately from the permission to move nodes. */
export function captureLayoutPreservation(
  nodes: readonly LayoutNodeSnapshot[],
  relations: readonly StructureRelation[] = [],
): LayoutPreservation {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const containers: LayoutPreservation['containers'] = []
  const addContainment = (parent: string, child: string) => {
    if (parent !== child && byId.has(parent) && byId.has(child)
      && !containers.some((pair) => pair.parent === parent && pair.child === child)) {
      containers.push({ parent, child })
    }
  }
  // Existing containment is protected, not inferred as permission to rearrange a region.
  for (const parent of nodes) for (const child of nodes) {
    if (parent.containerCandidate && parent.w * parent.h > child.w * child.h && boxContains(parent, child)) {
      addContainment(parent.id, child.id)
    }
  }
  const groups: LayoutPreservation['groups'] = { x: [], y: [] }
  const addGroup = (axis: Axis, ids: readonly string[]) => {
    const live = [...new Set(ids.filter((id) => byId.has(id)))]
    if (live.length > 1) groups[axis].push(live)
  }
  for (const relation of relations) {
    if (relation.kind === 'contain') {
      for (const child of relation.children) addContainment(relation.parent, child)
    } else if (relation.kind === 'align') {
      addGroup(relation.axis === 'col' ? 'x' : 'y', relation.nodes)
    } else if (relation.kind === 'grid') {
      for (let start = 0; start < relation.nodes.length; start += relation.cols) {
        addGroup('y', relation.nodes.slice(start, start + relation.cols))
      }
      for (let col = 0; col < relation.cols; col++) {
        addGroup('x', relation.nodes.filter((_, index) => index % relation.cols === col))
      }
    }
  }
  const ignoredOverlaps = new Set(containers.map(({ parent, child }) => overlapPairKey(parent, child)))
  const nearestParent = (id: string): string | undefined => containers
    .filter((pair) => pair.child === id)
    .sort((a, b) => {
      const pa = byId.get(a.parent)!
      const pb = byId.get(b.parent)!
      return pa.w * pa.h - pb.w * pb.h
    })[0]?.parent
  const parents = new Map(nodes.map((node) => [node.id, nearestParent(node.id)]))
  const order: LayoutPreservation['order'] = []
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i]
    const b = nodes[j]
    if (ignoredOverlaps.has(overlapPairKey(a.id, b.id)) || parents.get(a.id) !== parents.get(b.id)) continue
    for (const axis of ['x', 'y'] as const) {
      const cross = axis === 'x' ? 'y' : 'x'
      // Do not lock coincident boxes on both axes: they may be accidental duplicates.
      const distinctAcross = Math.abs(center(a, cross) - center(b, cross)) > ALIGN_TOLERANCE
      const aligned = [0, 0.5, 1].some((anchor) =>
        Math.abs(a[axis] + extent(a, axis) * anchor - b[axis] - extent(b, axis) * anchor) <= ALIGN_TOLERANCE)
      if (a.alignable !== false && b.alignable !== false && distinctAcross && aligned) addGroup(axis, [a.id, b.id])
      if (a[axis] + extent(a, axis) <= b[axis]) order.push({ before: a.id, after: b.id, axis })
      else if (b[axis] + extent(b, axis) <= a[axis]) order.push({ before: b.id, after: a.id, axis })
    }
  }
  return { groups, containers, order, ignoredOverlaps }
}

export function requiredFlowGap(edge: PlannedSpacingEdge): number {
  const label = edge.axis === 'x' ? edge.labelW : edge.labelH
  return Math.max(edge.minGap, label == null ? 0 : label + 24)
}

const flowGap = (a: LayoutBox, b: LayoutBox, edge: PlannedSpacingEdge): number =>
  b[edge.axis] - a[edge.axis] - extent(a, edge.axis)

/** Expand declared forward chains only. Existing larger gaps and cross-axis positions survive. */
export function expandFlowSpacing(nodes: readonly LayoutBox[], edges: readonly PlannedSpacingEdge[]): Map<string, Pt> {
  const byId = new Map(nodes.map((node) => [node.id, { ...node }]))
  // Relax all incoming requirements instead of letting a UUID-sorted first parent win.
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false
    for (const edge of edges) {
      const a = byId.get(edge.from)
      const b = byId.get(edge.to)
      if (!a || !b || !b.movable) continue
      const deficit = requiredFlowGap(edge) - flowGap(a, b, edge)
      if (deficit <= EPSILON) continue
      b[edge.axis] += deficit
      changed = true
    }
    if (!changed) break
  }
  return new Map(nodes.flatMap((node) => {
    const next = byId.get(node.id)!
    return next.x !== node.x || next.y !== node.y ? [[node.id, { x: next.x, y: next.y }] as const] : []
  }))
}

export interface ProtectedMoves {
  moves: Map<string, Pt>
  candidate: LayoutBox[]
  issues: string[]
}

/** Extend a proposal to aligned rows/columns and reject composition regressions atomically. */
export function protectLayoutMoves(
  nodes: readonly LayoutBox[],
  proposed: ReadonlyMap<string, Pt>,
  preservation: LayoutPreservation,
  spacingEdges: readonly PlannedSpacingEdge[] = [],
): ProtectedMoves {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const deltas = new Map<string, Pt>(nodes.map((node) => {
    const next = proposed.get(node.id) ?? node
    return [node.id, { x: next.x - node.x, y: next.y - node.y }] as const
  }))
  const issues = new Set<string>()
  for (let pass = 0; pass <= nodes.length; pass++) {
    let changed = false
    for (const axis of ['x', 'y'] as const) {
      const groups = [...preservation.groups[axis]]
      for (const { parent, child } of preservation.containers) {
        if (Math.abs(deltas.get(parent)?.[axis] ?? 0) > EPSILON) groups.push([parent, child])
      }
      for (const group of groups) {
        const offsets = group.map((id) => deltas.get(id)?.[axis] ?? 0).filter((delta) => Math.abs(delta) > EPSILON)
        if (!offsets.length) continue
        if (Math.min(...offsets) < 0 && Math.max(...offsets) > 0) {
          issues.add(`Conflicting ${axis}-moves would break alignment of ${group.join(', ')}.`)
          continue
        }
        const delta = offsets[0] > 0 ? Math.max(...offsets) : Math.min(...offsets)
        for (const id of group) {
          const offset = deltas.get(id)
          if (offset && Math.abs(offset[axis] - delta) > EPSILON) {
            offset[axis] = delta
            changed = true
          }
        }
      }
    }
    if (!changed) break
  }
  const candidate = nodes.map((node) => {
    const delta = deltas.get(node.id)!
    if ((Math.abs(delta.x) > EPSILON || Math.abs(delta.y) > EPSILON) && !node.movable) {
      issues.add(`Repair needs to move frozen/context-only shape ${node.id}; original layout retained.`)
    }
    return { ...node, x: node.x + delta.x, y: node.y + delta.y }
  })
  const after = new Map(candidate.map((node) => [node.id, node]))
  for (const { parent, child } of preservation.containers) {
    const p = after.get(parent)
    const c = after.get(child)
    if (p && c && !boxContains(p, c)) {
      issues.add(`Container ${parent} cannot accommodate ${child} at the proposed position without changing its size.`)
    }
  }
  for (const { before, after: next, axis } of preservation.order) {
    const a = after.get(before)
    const b = after.get(next)
    if (a && b && center(a, axis) >= center(b, axis) - EPSILON) {
      issues.add(`Repair would reverse the original ${axis}-order of ${before}, ${next}.`)
    }
  }
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i]
    const b = nodes[j]
    if (preservation.ignoredOverlaps.has(overlapPairKey(a.id, b.id))) continue
    if (overlapArea(candidate[i], candidate[j]) > overlapArea(a, b) + EPSILON) {
      issues.add(`Repair would introduce or worsen an overlap between ${a.id}, ${b.id}.`)
    }
  }
  for (const edge of spacingEdges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (!a || !b) continue
    const required = requiredFlowGap(edge)
    const beforeDeficit = Math.max(0, required - flowGap(a, b, edge))
    const afterDeficit = Math.max(0, required - flowGap(after.get(a.id)!, after.get(b.id)!, edge))
    if (afterDeficit > beforeDeficit + EPSILON) {
      issues.add(`Repair would shorten the connector corridor between ${a.id}, ${b.id}.`)
    }
  }
  const moves = new Map<string, Pt>()
  if (!issues.size) for (const node of candidate) {
    const old = byId.get(node.id)!
    if (Math.abs(node.x - old.x) > EPSILON || Math.abs(node.y - old.y) > EPSILON) moves.set(node.id, { x: node.x, y: node.y })
  }
  return { moves, candidate, issues: [...issues] }
}

export function remainingLayoutConflicts(
  nodes: readonly LayoutBox[],
  preservation: LayoutPreservation,
  edges: readonly PlannedSpacingEdge[],
): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const issues: string[] = []
  for (const { parent, child } of preservation.containers) {
    const p = byId.get(parent)
    const c = byId.get(child)
    if (p && c && (p.movable || c.movable) && !boxContains(p, c)) {
      issues.push(`Container ${parent} has insufficient space for ${child}; explicit placement/size correction is needed.`)
    }
  }
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i]
    const b = nodes[j]
    if ((!a.movable && !b.movable) || preservation.ignoredOverlaps.has(overlapPairKey(a.id, b.id))) continue
    if (overlapArea(a, b) > EPSILON) issues.push(`Unresolved overlap: ${a.id}, ${b.id}; original composition preserved.`)
  }
  for (const edge of edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (a && b && flowGap(a, b, edge) < requiredFlowGap(edge) - EPSILON) {
      issues.push(`Connector ${a.id} -> ${b.id} needs ${requiredFlowGap(edge)}px of clear space; original composition preserved.`)
    }
  }
  return issues
}
