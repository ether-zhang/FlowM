/**
 * Layout repair — generalises the bound-arrow principle ("the system computes
 * the geometry; it does NOT trust the model's coordinates", see bindingGeometry.ts)
 * from arrow endpoints to shape placement and arrow routing. Two pure functions:
 *
 *  - resolveOverlaps: the model routinely returns x/y/w/h that overlap (a new
 *    node dropped onto an existing one, two siblings stacked). updateScene applies
 *    them verbatim. This nudges intersecting boxes apart with minimal displacement,
 *    preserving the model's intent (which shapes exist, roughly where) while
 *    removing the unwanted overlap.
 *  - routeBoundArrow: once shapes settle, a straight connector can still cut
 *    through a third shape. When it does, bow the arrow with a single mid point to
 *    clear the blocker; otherwise leave it straight. Endpoints are re-solved against
 *    that mid point (via bindingGeometry) so a curved bound arrow stays a fixed
 *    point of Excalidraw's native recompute — no jump on the next nudge.
 *
 * Dependency-free apart from bindingGeometry's pure solver, so both are unit-tested
 * headlessly. Single-blocker, single-bow on purpose; multi-obstacle / global routing
 * is a documented follow-up (see FlowM.md 布局优化).
 */
import { solveEndpoint, type Pt, type Shape } from './bindingGeometry'

export interface LayoutBox {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** Shapes created/moved this batch may be repositioned; pre-existing ones are pinned. */
  movable: boolean
}

/** Default clear gap kept between boxes, and the arrow-routing clearance, in px. */
const MARGIN = 16
const CLEARANCE = 10

// --- overlap avoidance (58) ---

/**
 * Vector to displace `a` away from `b` when they actually overlap, leaving a
 * `margin` gap; null when they're already separated. Only true overlaps are
 * fixed — a tight-but-clear layout the model placed on purpose is left alone.
 */
function separation(a: LayoutBox, b: LayoutBox, margin: number): Pt | null {
  const penX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const penY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (penX <= 0 || penY <= 0) return null // not actually overlapping
  const acx = a.x + a.w / 2
  const acy = a.y + a.h / 2
  const bcx = b.x + b.w / 2
  const bcy = b.y + b.h / 2
  // Separate along the axis of least penetration (smallest, least-disruptive move).
  if (penX < penY) return { x: (acx <= bcx ? -1 : 1) * (penX + margin), y: 0 }
  return { x: 0, y: (acy <= bcy ? -1 : 1) * (penY + margin) }
}

/**
 * Nudge overlapping boxes apart by iterative relaxation. A movable/movable pair
 * splits the push; a movable/pinned pair moves only the movable one; two pinned
 * boxes are left alone (nothing we may move). Returns only the boxes that moved.
 */
export function resolveOverlaps(
  boxes: LayoutBox[],
  opts: { margin?: number; iterations?: number } = {},
): Map<string, Pt> {
  const margin = opts.margin ?? MARGIN
  const iterations = opts.iterations ?? 60
  const pos = boxes.map((b) => ({ ...b }))
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i]
        const b = pos[j]
        if (!a.movable && !b.movable) continue
        const mtv = separation(a, b, margin)
        if (!mtv) continue
        moved = true
        if (a.movable && b.movable) {
          a.x += mtv.x / 2
          a.y += mtv.y / 2
          b.x -= mtv.x / 2
          b.y -= mtv.y / 2
        } else if (a.movable) {
          a.x += mtv.x
          a.y += mtv.y
        } else {
          b.x -= mtv.x
          b.y -= mtv.y
        }
      }
    }
    if (!moved) break
  }
  const out = new Map<string, Pt>()
  for (let i = 0; i < pos.length; i++) {
    if (pos[i].x !== boxes[i].x || pos[i].y !== boxes[i].y) out.set(boxes[i].id, { x: pos[i].x, y: pos[i].y })
  }
  return out
}

// --- arrow routing (59) ---

const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y

/** Does segment p→q pass through `b` grown by `pad` on every side? (Liang–Barsky clip.) */
function segmentHitsBox(p: Pt, q: Pt, b: LayoutBox, pad: number): boolean {
  const dx = q.x - p.x
  const dy = q.y - p.y
  let t0 = 0
  let t1 = 1
  // Each edge as a (p_k, q_k) clip; returns false when the segment is wholly outside.
  const edges: Array<[number, number]> = [
    [-dx, p.x - (b.x - pad)],
    [dx, b.x + b.w + pad - p.x],
    [-dy, p.y - (b.y - pad)],
    [dy, b.y + b.h + pad - p.y],
  ]
  for (const [pk, qk] of edges) {
    if (pk === 0) {
      if (qk < 0) return false // parallel and outside this slab
      continue
    }
    const r = qk / pk
    if (pk < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
  }
  return t0 <= t1
}

export interface ArrowRoute {
  start: Pt
  end: Pt
  /** Bend point to bow through, or null when a straight line is clear. */
  mid: Pt | null
}

/**
 * Route a (possibly bound) arrow from `start` to `end` around any `obstacles` its
 * straight segment would cross. Returns a single bend point when bowing is needed,
 * else `mid: null`. When an endpoint is bound, it is re-solved to aim at the bend
 * point so the curved arrow remains a fixed point of the native binding recompute.
 */
export function routeBoundArrow(opts: {
  startShape?: Shape
  endShape?: Shape
  start: Pt
  end: Pt
  obstacles: LayoutBox[]
  gap: number
  clearance?: number
}): ArrowRoute {
  const { startShape, endShape, start, end, obstacles, gap } = opts
  const clearance = opts.clearance ?? CLEARANCE
  const blockers = obstacles.filter((o) => segmentHitsBox(start, end, o, clearance))
  if (blockers.length === 0) return { start, end, mid: null }

  // Route around the blocker nearest the segment midpoint.
  const segMid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  let o = blockers[0]
  let best = Infinity
  for (const cand of blockers) {
    const d = (cand.x + cand.w / 2 - segMid.x) ** 2 + (cand.y + cand.h / 2 - segMid.y) ** 2
    if (d < best) {
      best = d
      o = cand
    }
  }

  const dir = { x: end.x - start.x, y: end.y - start.y }
  const L = Math.hypot(dir.x, dir.y) || 1
  const u = { x: dir.x / L, y: dir.y / L }
  const n = { x: -u.y, y: u.x } // unit normal
  const oc = { x: o.x + o.w / 2, y: o.y + o.h / 2 }
  const rel = { x: oc.x - start.x, y: oc.y - start.y }

  // Bend base = obstacle centre projected onto the line, clamped off the endpoints.
  const t = Math.max(L * 0.2, Math.min(L * 0.8, dot(rel, u)))
  const base = { x: start.x + u.x * t, y: start.y + u.y * t }

  // Push the apex to whichever side clears the obstacle's normal extent with less bow.
  const sd = dot(rel, n)
  const radius = (Math.abs(o.w * n.x) + Math.abs(o.h * n.y)) / 2
  const offPlus = sd + radius + clearance
  const offMinus = sd - radius - clearance
  const off = Math.abs(offPlus) <= Math.abs(offMinus) ? offPlus : offMinus
  const mid = { x: base.x + n.x * off, y: base.y + n.y * off }

  // Re-aim bound endpoints at the bend (Excalidraw recomputes ends from points[1]).
  const s = startShape ? solveEndpoint(startShape, 0, gap, mid) : start
  const e = endShape ? solveEndpoint(endShape, 0, gap, mid) : end
  return { start: s, end: e, mid }
}
