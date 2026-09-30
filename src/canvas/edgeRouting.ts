import { solveEndpoint, type Pt, type Shape } from './bindingGeometry'
import { routeBoundArrow, type LayoutBox, type PortFocus } from './layout'

export interface RoutedSegment {
  from: Pt
  to: Pt
}

export interface RoutedArrow {
  points: Pt[]
  labelAnchor: Pt
  warnings: string[]
}

export interface RouteArrowOptions {
  startId?: string
  endId?: string
  startShape?: Shape
  endShape?: Shape
  start: Pt
  end: Pt
  obstacles: readonly LayoutBox[]
  /** Labels still avoid transparent container borders when path routing may cross them. */
  labelObstacles?: readonly LayoutBox[]
  occupied?: readonly RoutedSegment[]
  label?: { w: number; h: number }
  gap: number
  clearance?: number
  offset?: number
  focus?: PortFocus
  /** Existing bends after reattaching endpoints; keep them whenever they are still clear. */
  preferredPoints?: readonly Pt[]
}

const DEFAULT_CLEARANCE = 14
const LABEL_PAD = 12
const LANE_EPSILON = 2
const BEND_COST = 42
const CROSSING_COST = 320

const samePoint = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01

function removeAdjacentDuplicates(points: readonly Pt[]): Pt[] {
  const out: Pt[] = []
  for (const point of points) {
    if (!out.length || !samePoint(out[out.length - 1], point)) out.push(point)
  }
  return out
}

function removeCollinear(points: readonly Pt[]): Pt[] {
  const out: Pt[] = []
  for (const point of removeAdjacentDuplicates(points)) {
    while (out.length >= 2) {
      const a = out[out.length - 2]
      const b = out[out.length - 1]
      const cross = (b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x)
      if (Math.abs(cross) > 0.01) break
      out.pop()
    }
    out.push(point)
  }
  return out
}

function segmentLength(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function routeSegments(points: readonly Pt[]): RoutedSegment[] {
  const out: RoutedSegment[] = []
  for (let i = 1; i < points.length; i++) {
    if (!samePoint(points[i - 1], points[i])) out.push({ from: points[i - 1], to: points[i] })
  }
  return out
}

/** Match Excalidraw's bound-text anchor rule for a linear element. */
export function arrowLabelAnchor(points: readonly Pt[]): Pt {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return points[0]
  const middle = Math.floor(points.length / 2)
  if (points.length % 2 === 1) return points[middle]
  const a = points[middle - 1]
  const b = points[middle]
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function arrowLabelTopLeft(points: readonly Pt[], width: number, height: number): Pt {
  const anchor = arrowLabelAnchor(points)
  return { x: anchor.x - width / 2, y: anchor.y - height / 2 }
}

function segmentHitsBox(a: Pt, b: Pt, box: LayoutBox, pad: number): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let near = 0
  let far = 1
  const clips: Array<[number, number]> = [
    [-dx, a.x - (box.x - pad)],
    [dx, box.x + box.w + pad - a.x],
    [-dy, a.y - (box.y - pad)],
    [dy, box.y + box.h + pad - a.y],
  ]
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const ratio = q / p
    if (p < 0) {
      if (ratio > far) return false
      near = Math.max(near, ratio)
    } else {
      if (ratio < near) return false
      far = Math.min(far, ratio)
    }
  }
  return near <= far
}

export function pathHitsBoxes(points: readonly Pt[], boxes: readonly LayoutBox[], pad = 0): boolean {
  return routeSegments(points).some((segment) => boxes.some((box) => segmentHitsBox(segment.from, segment.to, box, pad)))
}

function boxesOverlap(a: LayoutBox, b: LayoutBox, pad = 0): boolean {
  return a.x < b.x + b.w + pad && a.x + a.w > b.x - pad && a.y < b.y + b.h + pad && a.y + a.h > b.y - pad
}

export function routeNeedsUpdate(
  route: { id: string; from: string; to: string; points: readonly Pt[]; label?: LayoutBox; transparentObstacleIds?: readonly string[] },
  changedNodes: ReadonlySet<string>,
  changedEdges: ReadonlySet<string>,
  changedObstacles: readonly LayoutBox[],
): boolean {
  if (changedEdges.has(route.id) || changedNodes.has(route.from) || changedNodes.has(route.to)) return true
  const ignored = new Set([route.from, route.to, ...(route.transparentObstacleIds ?? [])])
  const obstacles = changedObstacles.filter((box) => !ignored.has(box.id))
  return pathHitsBoxes(route.points, obstacles, DEFAULT_CLEARANCE)
    || !!route.label && obstacles.some((box) => boxesOverlap(route.label!, box, 4))
}

function orientation(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function between(a: number, b: number, c: number): boolean {
  return b >= Math.min(a, c) - 0.01 && b <= Math.max(a, c) + 0.01
}

function segmentsIntersect(a: RoutedSegment, b: RoutedSegment): boolean {
  const o1 = orientation(a.from, a.to, b.from)
  const o2 = orientation(a.from, a.to, b.to)
  const o3 = orientation(b.from, b.to, a.from)
  const o4 = orientation(b.from, b.to, a.to)
  if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) return true
  if (Math.abs(o1) < 0.01 && between(a.from.x, b.from.x, a.to.x) && between(a.from.y, b.from.y, a.to.y)) return true
  if (Math.abs(o2) < 0.01 && between(a.from.x, b.to.x, a.to.x) && between(a.from.y, b.to.y, a.to.y)) return true
  if (Math.abs(o3) < 0.01 && between(b.from.x, a.from.x, b.to.x) && between(b.from.y, a.from.y, b.to.y)) return true
  if (Math.abs(o4) < 0.01 && between(b.from.x, a.to.x, b.to.x) && between(b.from.y, a.to.y, b.to.y)) return true
  return false
}

function ensureLabelSegment(points: readonly Pt[]): Pt[] {
  const clean = removeAdjacentDuplicates(points)
  if (clean.length % 2 === 0 || clean.length < 3) return clean
  const middle = Math.floor(clean.length / 2)
  const before = segmentLength(clean[middle - 1], clean[middle])
  const after = segmentLength(clean[middle], clean[middle + 1])
  if (before >= after) {
    const a = clean[middle - 1]
    const b = clean[middle]
    const split = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    return [...clean.slice(0, middle), split, ...clean.slice(middle)]
  }
  const a = clean[middle]
  const b = clean[middle + 1]
  const split = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  return [...clean.slice(0, middle + 1), split, ...clean.slice(middle + 1)]
}

function labelFits(points: readonly Pt[], label: { w: number; h: number }, boxes: readonly LayoutBox[]): boolean {
  if (points.length < 2 || points.length % 2 !== 0) return false
  const middle = points.length / 2
  const a = points[middle - 1]
  const b = points[middle]
  const length = segmentLength(a, b)
  if (length < 1) return false
  const dx = Math.abs((b.x - a.x) / length)
  const dy = Math.abs((b.y - a.y) / length)
  const required = label.w * dx + label.h * dy + 2 * LABEL_PAD
  if (length < required) return false
  const topLeft = arrowLabelTopLeft(points, label.w, label.h)
  const labelBox: LayoutBox = { id: '__edge_label__', x: topLeft.x, y: topLeft.y, w: label.w, h: label.h, movable: false }
  return !boxes.some((box) => boxesOverlap(labelBox, box, 4))
}

function solveHorizontal(opts: RouteArrowOptions, laneY: number): Pt[] {
  const focus = opts.focus ?? { start: 0, end: 0 }
  const start = opts.startShape
    ? solveEndpoint(opts.startShape, focus.start, opts.gap, { x: opts.start.x, y: laneY })
    : opts.start
  const end = opts.endShape
    ? solveEndpoint(opts.endShape, focus.end, opts.gap, { x: opts.end.x, y: laneY })
    : opts.end
  return [start, { x: start.x, y: laneY }, { x: end.x, y: laneY }, end]
}

function solveVertical(opts: RouteArrowOptions, laneX: number): Pt[] {
  const focus = opts.focus ?? { start: 0, end: 0 }
  const start = opts.startShape
    ? solveEndpoint(opts.startShape, focus.start, opts.gap, { x: laneX, y: opts.start.y })
    : opts.start
  const end = opts.endShape
    ? solveEndpoint(opts.endShape, focus.end, opts.gap, { x: laneX, y: opts.end.y })
    : opts.end
  return [start, { x: laneX, y: start.y }, { x: laneX, y: end.y }, end]
}

function solveSelfLoops(opts: RouteArrowOptions, clearance: number): Pt[][] {
  const shape = opts.startShape
  if (!shape) return []
  const focus = opts.focus ?? { start: -0.2, end: 0.2 }
  const cx = shape.x + shape.width / 2
  const cy = shape.y + shape.height / 2
  const lane = clearance + opts.gap + 32 + Math.abs(opts.offset ?? 0)
  const right = shape.x + shape.width + lane
  const left = shape.x - lane
  const top = shape.y - lane
  const bottom = shape.y + shape.height + lane
  const verticalSpan = Math.max(shape.height / 2, (opts.label?.h ?? 0) + 2 * LABEL_PAD)
  const horizontalSpan = Math.max(shape.width / 2, (opts.label?.w ?? 0) + 2 * LABEL_PAD)
  const solve = (startTarget: Pt, endTarget: Pt, middleA: Pt, middleB: Pt): Pt[] => {
    const start = solveEndpoint(shape, focus.start, opts.gap, startTarget)
    const end = solveEndpoint(shape, focus.end, opts.gap, endTarget)
    return [start, middleA, middleB, end]
  }
  return [
    solve(
      { x: right, y: cy - verticalSpan / 2 },
      { x: right, y: cy + verticalSpan / 2 },
      { x: right, y: cy - verticalSpan / 2 },
      { x: right, y: cy + verticalSpan / 2 },
    ),
    solve(
      { x: left, y: cy - verticalSpan / 2 },
      { x: left, y: cy + verticalSpan / 2 },
      { x: left, y: cy - verticalSpan / 2 },
      { x: left, y: cy + verticalSpan / 2 },
    ),
    [
      solveEndpoint(shape, focus.start, opts.gap, { x: cx - horizontalSpan / 2, y: top }),
      { x: cx - horizontalSpan / 2, y: top },
      { x: cx + horizontalSpan / 2, y: top },
      solveEndpoint(shape, focus.end, opts.gap, { x: cx + horizontalSpan / 2, y: top }),
    ],
    [
      solveEndpoint(shape, focus.start, opts.gap, { x: cx - horizontalSpan / 2, y: bottom }),
      { x: cx - horizontalSpan / 2, y: bottom },
      { x: cx + horizontalSpan / 2, y: bottom },
      solveEndpoint(shape, focus.end, opts.gap, { x: cx + horizontalSpan / 2, y: bottom }),
    ],
  ]
}

function scorePath(points: readonly Pt[], occupied: readonly RoutedSegment[]): number {
  const segments = routeSegments(points)
  const length = segments.reduce((sum, segment) => sum + segmentLength(segment.from, segment.to), 0)
  let crossings = 0
  for (const segment of segments) for (const used of occupied) if (segmentsIntersect(segment, used)) crossings++
  return length + Math.max(0, points.length - 2) * BEND_COST + crossings * CROSSING_COST
}

/**
 * Route one edge against a shared batch state. Candidate lanes are deterministic and
 * finite: direct, horizontal corridors, and vertical corridors around every obstacle.
 * Previously routed edges contribute crossing cost while reserved label boxes are hard
 * obstacles, so the batch converges to stable lanes without giving the model pixel tools.
 */
export function routePlannedArrow(opts: RouteArrowOptions): RoutedArrow {
  const clearance = opts.clearance ?? DEFAULT_CLEARANCE
  const offset = opts.offset ?? 0
  const occupied = opts.occupied ?? []
  const routeObstacles = opts.obstacles.filter((box) => box.id !== opts.startId && box.id !== opts.endId)
  const labelObstacles = opts.labelObstacles ?? opts.obstacles
  if (opts.preferredPoints?.length && !pathHitsBoxes(opts.preferredPoints, routeObstacles, clearance)) {
    const pos = arrowLabelTopLeft(opts.preferredPoints, opts.label?.w ?? 0, opts.label?.h ?? 0)
    const labelBox: LayoutBox = { id: '__label__', ...pos, w: opts.label?.w ?? 0, h: opts.label?.h ?? 0, movable: false }
    if (!opts.label || !labelObstacles.some((box) => boxesOverlap(labelBox, box, 4))) {
      const points = opts.preferredPoints.map((point) => ({ ...point }))
      return { points, labelAnchor: arrowLabelAnchor(points), warnings: [] }
    }
  }
  const candidates: Pt[][] = []

  if (opts.startId && opts.startId === opts.endId) {
    candidates.push(...solveSelfLoops(opts, clearance))
  } else {
    if (offset === 0) candidates.push([opts.start, opts.end])

    const horizontalBias = Math.abs(opts.end.x - opts.start.x) >= Math.abs(opts.end.y - opts.start.y)
    const preferredY = (opts.start.y + opts.end.y) / 2 + (horizontalBias ? offset : 0)
    const preferredX = (opts.start.x + opts.end.x) / 2 + (horizontalBias ? 0 : offset)
    const ys = new Set<number>([preferredY, opts.start.y, opts.end.y])
    const xs = new Set<number>([preferredX, opts.start.x, opts.end.x])
    for (const box of routeObstacles) {
      ys.add(box.y - clearance - LANE_EPSILON)
      ys.add(box.y + box.h + clearance + LANE_EPSILON)
      xs.add(box.x - clearance - LANE_EPSILON)
      xs.add(box.x + box.w + clearance + LANE_EPSILON)
    }
    for (const segment of occupied) {
      ys.add(Math.min(segment.from.y, segment.to.y) - clearance - LANE_EPSILON)
      ys.add(Math.max(segment.from.y, segment.to.y) + clearance + LANE_EPSILON)
      xs.add(Math.min(segment.from.x, segment.to.x) - clearance - LANE_EPSILON)
      xs.add(Math.max(segment.from.x, segment.to.x) + clearance + LANE_EPSILON)
    }
    for (const y of [...ys].sort((a, b) => Math.abs(a - preferredY) - Math.abs(b - preferredY) || a - b)) {
      candidates.push(solveHorizontal(opts, y))
    }
    for (const x of [...xs].sort((a, b) => Math.abs(a - preferredX) - Math.abs(b - preferredX) || a - b)) {
      candidates.push(solveVertical(opts, x))
    }
  }

  const valid = candidates
    .map((candidate) => (opts.label ? ensureLabelSegment(candidate) : removeCollinear(candidate)))
    .filter((candidate) => candidate.length >= 2)
    .filter((candidate) => !pathHitsBoxes(candidate, routeObstacles, clearance))
    .filter((candidate) => !opts.label || labelFits(candidate, opts.label, labelObstacles))
    .map((candidate) => ({ candidate, score: scorePath(candidate, occupied) }))
    .sort((a, b) => a.score - b.score)

  let points = valid[0]?.candidate
  const warnings: string[] = []
  if (!points) {
    const focus = opts.focus ?? { start: 0, end: 0 }
    const fallback = routeBoundArrow({
      startShape: opts.startShape,
      endShape: opts.endShape,
      start: opts.start,
      end: opts.end,
      obstacles: routeObstacles,
      gap: opts.gap,
      clearance,
      offset,
      startFocus: focus.start,
      endFocus: focus.end,
    })
    const fallbackPoints = fallback.mid ? [fallback.start, fallback.mid, fallback.end] : [fallback.start, fallback.end]
    const candidate = opts.label ? ensureLabelSegment(fallbackPoints) : fallbackPoints
    if (!pathHitsBoxes(candidate, routeObstacles, clearance)
      && (!opts.label || labelFits(candidate, opts.label, labelObstacles))) {
      points = candidate
    } else {
      // An unvalidated fallback must not replace an existing composition with a new detour.
      points = opts.preferredPoints?.map((point) => ({ ...point })) ?? [opts.start, opts.end]
      warnings.push('No collision-free route with sufficient label space was found; original direction retained.')
    }
  }

  return { points, labelAnchor: arrowLabelAnchor(points), warnings }
}
