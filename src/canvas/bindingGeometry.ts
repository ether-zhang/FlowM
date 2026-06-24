/**
 * Bound-arrow endpoint geometry — a faithful reimplementation of Excalidraw's
 * native binding math (the `updateBoundPoint` / `intersectElementWithLineSegment`
 * pipeline) as dependency-free pure functions.
 *
 * Why this exists: Excalidraw recomputes a bound arrow's endpoint only from its
 * interactive pointer pipeline; `updateScene` (how FlowM writes the canvas) does
 * NOT trigger it, and the function that does (`updateBoundElements`) is not
 * reachable at runtime from the package. So when FlowM moves/creates shapes
 * programmatically it must produce the endpoint ITSELF — and to avoid the arrow
 * visibly jumping the first time the user nudges a shape (which DOES run the
 * native pipeline), our endpoint must equal what the native pipeline would
 * produce, i.e. be a fixed point of it. The earlier center-ray + radial-gap
 * approximation diverged on diamonds/ellipses; this replicates the real math.
 *
 * Algorithm ported (rewritten, not copied) from Excalidraw (MIT License,
 * Copyright (c) 2020 Excalidraw): for a non-elbow arrow, the endpoint bound to a
 * shape is the intersection of the shape's outline (expanded outward by `gap`)
 * with the ray from the arrow's OTHER endpoint toward the shape's focus point
 * (focus=0 ⇒ the shape's centre), taking the intersection nearest that other
 * endpoint. Per-shape intersection: rectangle = 4 grown edges, diamond = 4 grown
 * edges, ellipse = analytic line/ellipse solve on half-axes grown by `gap`.
 */

export interface Pt {
  x: number
  y: number
}

/** Minimal shape view this module needs (structurally satisfied by Excalidraw elements). */
export interface Shape {
  x: number
  y: number
  width: number
  height: number
  type: string
  angle?: number
}

// --- tuple-based primitives (mirror Excalidraw's math helpers) ---
type V = readonly [number, number]

const PRECISION = 1e-4

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]]
const cross = (a: V, b: V) => a[0] * b[1] - a[1] * b[0]
const dist = (a: V, b: V) => Math.hypot(b[0] - a[0], b[1] - a[1])
const distSq = (a: V, b: V) => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  return dx * dx + dy * dy
}
const normalize = (v: V): V => {
  const m = Math.hypot(v[0], v[1])
  return m === 0 ? [0, 0] : [v[0] / m, v[1] / m]
}

function rotate(p: V, c: V, angle: number): V {
  if (!angle) return p
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = p[0] - c[0]
  const dy = p[1] - c[1]
  return [dx * cos - dy * sin + c[0], dx * sin + dy * cos + c[1]]
}

/** Intersection of two infinite lines (each given by two points), or null if parallel. */
function linesIntersectAt(a: readonly [V, V], b: readonly [V, V]): V | null {
  const A1 = a[1][1] - a[0][1]
  const B1 = a[0][0] - a[1][0]
  const A2 = b[1][1] - b[0][1]
  const B2 = b[0][0] - b[1][0]
  const D = A1 * B2 - A2 * B1
  if (D === 0) return null
  const C1 = A1 * a[0][0] + B1 * a[0][1]
  const C2 = A2 * b[0][0] + B2 * b[0][1]
  return [(C1 * B2 - C2 * B1) / D, (A1 * C2 - A2 * C1) / D]
}

function onSegment(p: V, seg: readonly [V, V]): boolean {
  const [a, b] = seg
  const C = b[0] - a[0]
  const Dy = b[1] - a[1]
  const lenSq = C * C + Dy * Dy
  let param = -1
  if (lenSq !== 0) param = ((p[0] - a[0]) * C + (p[1] - a[1]) * Dy) / lenSq
  let xx: number
  let yy: number
  if (param < 0) {
    xx = a[0]
    yy = a[1]
  } else if (param > 1) {
    xx = b[0]
    yy = b[1]
  } else {
    xx = a[0] + param * C
    yy = a[1] + param * Dy
  }
  return Math.hypot(p[0] - xx, p[1] - yy) < PRECISION
}

/** Intersection point of two segments if it lies on both, else null. */
function segmentIntersect(l: readonly [V, V], s: readonly [V, V]): V | null {
  const p = linesIntersectAt(l, s)
  if (!p || !onSegment(p, s) || !onSegment(p, l)) return null
  return p
}

const center = (s: Shape): V => [s.x + s.width / 2, s.y + s.height / 2]

/** Four edges of the (unrotated) rectangle outline grown outward by `offset`. */
function rectSides(s: Shape, offset: number): Array<readonly [V, V]> {
  const x0 = s.x - offset
  const y0 = s.y - offset
  const x1 = s.x + s.width + offset
  const y1 = s.y + s.height + offset
  return [
    [[x0, y0], [x1, y0]],
    [[x1, y0], [x1, y1]],
    [[x0, y1], [x1, y1]],
    [[x0, y1], [x0, y0]],
  ]
}

/** Four edges of the (unrotated) diamond outline; each cardinal vertex pushed out by `offset`. */
function diamondSides(s: Shape, offset: number): Array<readonly [V, V]> {
  const cx = s.x + s.width / 2
  const cy = s.y + s.height / 2
  const top: V = [cx, s.y - offset]
  const right: V = [s.x + s.width + offset, cy]
  const bottom: V = [cx, s.y + s.height + offset]
  const left: V = [s.x - offset, cy]
  return [
    [top, right],
    [right, bottom],
    [bottom, left],
    [left, top],
  ]
}

/** Analytic line/ellipse intersection (ellipse centred at `c`, half-axes a/b). */
function ellipseLineIntersect(c: V, a: number, b: number, g: V, h: V): V[] {
  const x1 = g[0] - c[0]
  const y1 = g[1] - c[1]
  const x2 = h[0] - c[0]
  const y2 = h[1] - c[1]
  const A = (x2 - x1) ** 2 / a ** 2 + (y2 - y1) ** 2 / b ** 2
  const B = 2 * ((x1 * (x2 - x1)) / a ** 2 + (y1 * (y2 - y1)) / b ** 2)
  const C = x1 ** 2 / a ** 2 + y1 ** 2 / b ** 2 - 1
  const disc = B * B - 4 * A * C
  if (disc < 0 || A === 0) return []
  const root = Math.sqrt(disc)
  const ts = root === 0 ? [-B / (2 * A)] : [(-B + root) / (2 * A), (-B - root) / (2 * A)]
  return ts.map((t) => [x1 + t * (x2 - x1) + c[0], y1 + t * (y2 - y1) + c[1]] as V).filter((p) => !isNaN(p[0]) && !isNaN(p[1]))
}

/**
 * Points where the segment a→b crosses `shape`'s outline grown by `offset`.
 * Mirrors Excalidraw: rotate the ray into the shape's unrotated frame, intersect,
 * rotate results back. Rectangle/diamond use edge segments; ellipse is analytic.
 */
function intersectShape(shape: Shape, offset: number, a: Pt, b: Pt): V[] {
  const c = center(shape)
  const angle = shape.angle ?? 0
  const ra = rotate([a.x, a.y], c, -angle)
  const rb = rotate([b.x, b.y], c, -angle)

  if (shape.type === 'ellipse') {
    return ellipseLineIntersect(c, shape.width / 2 + offset, shape.height / 2 + offset, ra, rb).map((p) =>
      rotate(p, c, angle),
    )
  }
  const sides = shape.type === 'diamond' ? diamondSides(shape, offset) : rectSides(shape, offset)
  const out: V[] = []
  for (const side of sides) {
    const hit = segmentIntersect([ra, rb], side)
    if (hit) {
      const back = rotate(hit, c, angle)
      if (!out.some((p) => Math.abs(p[0] - back[0]) < PRECISION && Math.abs(p[1] - back[1]) < PRECISION)) out.push(back)
    }
  }
  return out
}

/**
 * The point a binding aims at. focus=0 ⇒ the shape's centre. focus≠0 ⇒ a point
 * offset toward one of the four corners (rectangle) / cardinal vertices (diamond),
 * scaled by |focus| and chosen by which side the adjacent point faces. This is a
 * faithful port of Excalidraw's determineFocusPoint; focus is the value Excalidraw
 * itself stores in the binding (it OWNS focus/gap — see solveEndpoint usage), so we
 * must honour it or the endpoint jumps the moment the native pipeline recomputes.
 */
function determineFocusPoint(shape: Shape, focus: number, adjacent: V): V {
  const c = center(shape)
  if (focus === 0) return c
  const { x, y, width: w, height: h } = shape
  const angle = shape.angle ?? 0
  const raw: V[] =
    shape.type === 'diamond'
      ? [[x, y + h / 2], [x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h]]
      : [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
  const cand = raw
    .map((p): V => [c[0] + Math.abs(focus) * (p[0] - c[0]), c[1] + Math.abs(focus) * (p[1] - c[1])])
    .map((p) => rotate(p, c, angle))
  const f = (p: V, o: V): V => [p[0] - o[0], p[1] - o[1]]
  const sel = [
    cross(f(adjacent, cand[0]), f(cand[1], cand[0])) > 0 &&
      (focus > 0
        ? cross(f(adjacent, cand[1]), f(cand[2], cand[1])) < 0
        : cross(f(adjacent, cand[3]), f(cand[0], cand[3])) < 0),
    cross(f(adjacent, cand[1]), f(cand[2], cand[1])) > 0 &&
      (focus > 0
        ? cross(f(adjacent, cand[2]), f(cand[3], cand[2])) < 0
        : cross(f(adjacent, cand[0]), f(cand[1], cand[0])) < 0),
    cross(f(adjacent, cand[2]), f(cand[3], cand[2])) > 0 &&
      (focus > 0
        ? cross(f(adjacent, cand[3]), f(cand[0], cand[3])) < 0
        : cross(f(adjacent, cand[1]), f(cand[2], cand[1])) < 0),
    cross(f(adjacent, cand[3]), f(cand[0], cand[3])) > 0 &&
      (focus > 0
        ? cross(f(adjacent, cand[0]), f(cand[1], cand[0])) < 0
        : cross(f(adjacent, cand[2]), f(cand[3], cand[2])) < 0),
  ]
  if (sel[0]) return focus > 0 ? cand[1] : cand[0]
  if (sel[1]) return focus > 0 ? cand[2] : cand[1]
  if (sel[2]) return focus > 0 ? cand[3] : cand[2]
  return focus > 0 ? cand[0] : cand[3]
}

/**
 * New position of the arrow endpoint bound to `shape`, given the arrow's other
 * (adjacent) endpoint and the binding's `focus`/`gap`. Equals Excalidraw's native
 * `updateBoundPoint` output, so writing it makes the endpoint a fixed point of the
 * native pipeline (no jump when the user next nudges the shape). Pass the binding's
 * ACTUALLY-stored focus/gap — Excalidraw owns those and recomputes against them.
 */
export function solveEndpoint(shape: Shape, focus: number, gap: number, adjacent: Pt): Pt {
  const adj: V = [adjacent.x, adjacent.y]
  const fp = determineFocusPoint(shape, focus, adj)
  if (gap === 0) return { x: fp[0], y: fp[1] }

  const c = center(shape)
  // A ray from the adjacent point through the focus point, long enough to cross the shape.
  const reach = dist(adj, c) + dist(adj, fp) + Math.max(shape.width, shape.height) * 2
  const dir = normalize(sub(fp, adj))
  const far: Pt = { x: adj[0] + dir[0] * reach, y: adj[1] + dir[1] * reach }

  const hits = intersectShape(shape, gap, adjacent, far).sort((g, h) => distSq(g, adj) - distSq(h, adj))
  if (hits.length > 1) return { x: hits[0][0], y: hits[0][1] }
  // Degenerate (tangent / no crossing): fall back to the focus point, as the native code does.
  return { x: fp[0], y: fp[1] }
}

/** One end of a bound arrow: the shape it binds to plus the binding's stored focus/gap. */
export interface EndBinding {
  shape: Shape
  focus: number
  gap: number
}

/**
 * Resolve both endpoints of a bound arrow. When both ends are bound the endpoints
 * depend on each other, so iterate a few times to the mutual fixed point (matches
 * what the native pipeline converges to). An unbound end keeps its given point and
 * serves as the adjacent reference for the bound end.
 */
export function solveArrowEndpoints(opts: {
  start?: EndBinding
  end?: EndBinding
  curStart: Pt
  curEnd: Pt
}): { start: Pt; end: Pt } {
  let start = opts.curStart
  let end = opts.curEnd
  const iters = opts.start && opts.end ? 3 : 1
  for (let i = 0; i < iters; i++) {
    if (opts.start) start = solveEndpoint(opts.start.shape, opts.start.focus, opts.start.gap, end)
    if (opts.end) end = solveEndpoint(opts.end.shape, opts.end.focus, opts.end.gap, start)
  }
  return { start, end }
}
