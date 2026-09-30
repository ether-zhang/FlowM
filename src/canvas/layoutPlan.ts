import {
  assignParallelOffsets,
  assignPortFocus,
  bowedEdges,
  type LayoutBox,
  type PairedEdge,
  type PortFocus,
  type SpacingEdge,
} from './layout'
import type { StructureRelation } from '../protocol'
import { captureLayoutPreservation, type LayoutPreservation } from './layoutPreservation'

/**
 * The protocol-facing scope answers only "which nodes may move". This canvas-owned
 * view retains declared relations without turning them into additional permissions.
 */
export interface LayoutAuthorization {
  spacing: ReadonlySet<string>
  overlap: ReadonlySet<string>
  relations?: readonly StructureRelation[]
}

export interface LayoutLabelSnapshot {
  id: string
  w: number
  h: number
}

/** A measured, bound edge in the current canvas scene. */
export interface LayoutEdgeSnapshot extends PairedEdge {
  label?: LayoutLabelSnapshot
}

export interface LayoutNodeSnapshot extends LayoutBox {
  /** Only box-like region elements may become transparent ancestor containers. */
  containerCandidate?: boolean
  alignable?: boolean
}

export interface LayoutSceneSnapshot {
  nodes: readonly LayoutNodeSnapshot[]
  edges: readonly LayoutEdgeSnapshot[]
  authorization: LayoutAuthorization | null
  createdCount: number
  /** Capture once before intent passes so a later pass cannot redefine the original layout. */
  preservation?: LayoutPreservation
}

export interface PlannedSpacingEdge extends SpacingEdge {
  id: string
  /** Per-edge corridor floor derived from endpoint crowding. */
  minGap: number
  axis: 'x' | 'y'
}

export interface PlannedRouteEdge extends LayoutEdgeSnapshot {
  offset: number
  focus: PortFocus
  /** Ancestor containers of either endpoint are boundaries, not solid obstacles. */
  transparentObstacleIds: readonly string[]
}

export interface CompiledLayoutPlan {
  /** Immutable measured input used by every downstream phase. */
  nodes: readonly LayoutBox[]
  preservation: LayoutPreservation
  intent: {
    spacing: {
      enabled: boolean
      nodes: readonly LayoutBox[]
      edges: readonly PlannedSpacingEdge[]
      minimumGap: number
    }
    overlap: {
      enabled: boolean
      nodes: readonly LayoutBox[]
    }
  }
  routing: {
    /** Labeled edges run first so their text lanes can be reserved for later edges. */
    edges: readonly PlannedRouteEdge[]
  }
}

const MIN_CONNECTOR_GAP = 72
const MAX_CONNECTOR_GAP = 120
const EXTRA_LANE_GAP = 14

type Side = 'left' | 'right' | 'top' | 'bottom'

const center = (box: LayoutBox): { x: number; y: number } => ({
  x: box.x + box.w / 2,
  y: box.y + box.h / 2,
})

function facingSide(from: LayoutBox, to: LayoutBox): Side {
  const a = center(from)
  const b = center(to)
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

const incidenceKey = (id: string, side: Side): string => `${id}\u0000${side}`
const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function contains(parent: LayoutNodeSnapshot, child: LayoutNodeSnapshot): boolean {
  if (!parent.containerCandidate || parent.id === child.id || parent.w * parent.h <= child.w * child.h) return false
  const tolerance = 2
  return child.x >= parent.x - tolerance
    && child.y >= parent.y - tolerance
    && child.x + child.w <= parent.x + parent.w + tolerance
    && child.y + child.h <= parent.y + parent.h + tolerance
}

/**
 * Compile measured scene state into one deterministic execution plan. The model owns
 * topology and macro placement; this compiler derives only implementation geometry:
 * movable subsets, connector corridors, endpoint focus, edge ordering, and offsets.
 */
export function compileLayoutPlan(scene: LayoutSceneSnapshot): CompiledLayoutPlan {
  const nodes = scene.nodes.map((node) => ({ ...node }))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = scene.edges
    .filter((edge) => byId.has(edge.from) && byId.has(edge.to))
    .map((edge) => ({ ...edge, label: edge.label ? { ...edge.label } : undefined }))
    .sort((a, b) => compareId(a.id, b.id))

  const laneCounts = new Map<string, number>()
  const edgeSides = new Map<string, { from: Side; to: Side }>()
  for (const edge of edges) {
    const from = byId.get(edge.from)!
    const to = byId.get(edge.to)!
    const fromSide = facingSide(from, to)
    const toSide = facingSide(to, from)
    edgeSides.set(edge.id, { from: fromSide, to: toSide })
    for (const key of [incidenceKey(edge.from, fromSide), incidenceKey(edge.to, toSide)]) {
      laneCounts.set(key, (laneCounts.get(key) ?? 0) + 1)
    }
  }

  const allowedSpacing = scene.authorization?.spacing
  const declaredFlowNodes = new Set((scene.authorization?.relations ?? [])
    .flatMap((relation) => relation.kind === 'flow' ? relation.nodes : []))
  const spacingNodes = nodes.filter((node) => declaredFlowNodes.has(node.id))
    .map((node) => ({ ...node, movable: allowedSpacing?.has(node.id) ?? false }))
  const spacingIds = new Set(spacingNodes.map((node) => node.id))
  const flowPairs = new Map<string, 'x' | 'y'>()
  for (const relation of scene.authorization?.relations ?? []) {
    if (relation.kind !== 'flow') continue
    for (let i = 1; i < relation.nodes.length; i++) {
      const from = byId.get(relation.nodes[i - 1])
      const to = byId.get(relation.nodes[i])
      if (!from || !to) continue
      const dir = relation.dir ?? (Math.abs(to.y - from.y) >= Math.abs(to.x - from.x) ? 'down' : 'right')
      flowPairs.set(JSON.stringify([from.id, to.id]), dir === 'down' ? 'y' : 'x')
    }
  }
  const spacingEdges: PlannedSpacingEdge[] = edges
    .filter((edge) => spacingIds.has(edge.from) && spacingIds.has(edge.to)
      && flowPairs.has(JSON.stringify([edge.from, edge.to])))
    .map((edge) => {
      const sides = edgeSides.get(edge.id)!
      const crowd = Math.max(
        laneCounts.get(incidenceKey(edge.from, sides.from)) ?? 1,
        laneCounts.get(incidenceKey(edge.to, sides.to)) ?? 1,
      )
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        labelW: edge.label?.w,
        labelH: edge.label?.h,
        axis: flowPairs.get(JSON.stringify([edge.from, edge.to]))!,
        minGap: Math.min(MAX_CONNECTOR_GAP, MIN_CONNECTOR_GAP + (crowd - 1) * EXTRA_LANE_GAP),
      }
    })

  const allowedOverlap = scene.authorization?.overlap
  const overlapNodes = nodes.map((node) => ({
    ...node,
    movable: allowedOverlap ? allowedOverlap.has(node.id) : node.movable,
  }))

  const pairedEdges: PairedEdge[] = edges.map(({ id, from, to }) => ({ id, from, to }))
  const offsets = assignParallelOffsets(pairedEdges)
  const skipFocus = bowedEdges(pairedEdges, nodes)
  const focuses = assignPortFocus(
    pairedEdges,
    (id) => {
      const node = byId.get(id)
      return node ? center(node) : undefined
    },
    { skip: skipFocus },
  )

  const routeEdges: PlannedRouteEdge[] = edges
    .map((edge) => {
      const transparentObstacleIds = nodes
        .filter((candidate) => {
          const from = byId.get(edge.from)!
          const to = byId.get(edge.to)!
          return contains(candidate, from) || contains(candidate, to)
        })
        .map((candidate) => candidate.id)
        .sort()
      return {
        ...edge,
        offset: offsets.get(edge.id) ?? 0,
        focus: focuses.get(edge.id) ?? { start: 0, end: 0 },
        transparentObstacleIds,
      }
    })
    .sort((a, b) => {
      const labelOrder = Number(Boolean(b.label)) - Number(Boolean(a.label))
      return labelOrder || compareId(a.id, b.id)
    })

  return {
    nodes,
    preservation: scene.preservation ?? captureLayoutPreservation(nodes, scene.authorization?.relations),
    intent: {
      spacing: {
        enabled: scene.authorization != null && spacingEdges.length > 0,
        nodes: spacingNodes,
        edges: spacingEdges,
        minimumGap: MIN_CONNECTOR_GAP,
      },
      overlap: {
        enabled: overlapNodes.some((node) => node.movable),
        nodes: overlapNodes,
      },
    },
    routing: { edges: routeEdges },
  }
}
