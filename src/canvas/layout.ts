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

/** Default clear gap kept between boxes, the arrow-routing clearance, and the
 *  breathing room left around a bound arrow label, in px. */
const MARGIN = 16
const CLEARANCE = 10
const LABEL_PAD = 12

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

// --- content sizing + spacing normalisation (67 + 2) ---

/**
 * Rough box size needed to hold a label, by line count and longest line. CJK glyphs
 * count ~1em wide, ASCII ~0.6em — a cheap estimate with no font metrics or DOM, so it
 * stays unit-testable. Non-rectangular shapes inscribe their text in a smaller area,
 * so diamonds/ellipses get a bigger box. Callers grow only (max with the model size).
 */
export function labelBoxSize(text: string, type: string, fontSize = 20): { w: number; h: number } {
  const lineWidth = (s: string) => {
    let w = 0
    for (const ch of s) {
      const cp = ch.codePointAt(0) ?? 0
      // CJK ideographs/punctuation + fullwidth forms ≈ 1em; other (ASCII) ≈ 0.6em.
      const wide = (cp >= 0x3000 && cp <= 0x9fff) || (cp >= 0xff00 && cp <= 0xffef)
      w += wide ? fontSize : fontSize * 0.6
    }
    return w
  }
  const lines = text.split('\n')
  const longest = lines.reduce((m, s) => Math.max(m, lineWidth(s)), 0)
  let w = longest + fontSize * 2.4
  let h = lines.length * fontSize * 1.25 + fontSize * 1.6
  if (type === 'diamond') {
    w *= 1.8
    h *= 1.8
  } else if (type === 'ellipse') {
    w *= 1.35
    h *= 1.35
  }
  return { w: Math.ceil(w), h: Math.ceil(h) }
}

export interface SpacingEdge {
  from: string
  to: string
  /** Bound-arrow label size, if any. A horizontal label projects onto the edge
   *  direction (full width on a horizontal edge, ~one line on a vertical one), so a
   *  labeled diagonal/horizontal edge needs a wider gap for the label to fit. */
  labelW?: number
  labelH?: number
}

/** Distance from a box centre to its border along unit direction (dx,dy) (AABB ray exit). */
function halfExtentAlong(b: LayoutBox, dx: number, dy: number): number {
  const tx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx)
  const ty = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy)
  return Math.min(tx, ty)
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Even out the edge-to-edge gap between connected boxes to `gap`, measured along each
 * arrow's own direction — so it works for any layout direction, not just top-down. A
 * forward sweep in topological order places each child off its parent at the target
 * gap using real, content-sized extents; near-axis directions snap to the axis so
 * chains stay straight and aligned. Back-edges (loop-backs) are found by DFS and
 * skipped so they don't pull the flow together. Only `movable` boxes move; sources and
 * pinned boxes anchor. Returns the boxes that moved.
 *
 * `opts.gap` overrides the target; when omitted it defaults to the model's OWN median
 * edge gap, so the model keeps control of the spacing scale and the framework only
 * makes that rhythm consistent.
 */
export function normalizeSpacing(
  nodes: LayoutBox[],
  edges: SpacingEdge[],
  opts: { gap?: number } = {},
): Map<string, Pt> {
  let gap = opts.gap
  const byId = new Map(nodes.map((n) => [n.id, { ...n }]))
  const ids = [...byId.keys()].sort()
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) {
    if (e.from !== e.to && byId.has(e.from) && byId.has(e.to)) adj.get(e.from)!.push(e.to)
  }
  for (const id of ids) adj.get(id)!.sort()
  const labelOf = new Map<string, { w: number; h: number }>()
  for (const e of edges) {
    if (e.labelW != null && e.labelH != null && e.from !== e.to) labelOf.set(`${e.from}->${e.to}`, { w: e.labelW, h: e.labelH })
  }

  // Iterative DFS: flag back-edges (edge into an on-stack node), collect a topo order.
  const color = new Map<string, 0 | 1 | 2>(ids.map((id) => [id, 0])) // white | gray | black
  const back = new Set<string>()
  const topo: string[] = []
  for (const root of ids) {
    if (color.get(root) !== 0) continue
    const stack: Array<{ u: string; i: number }> = [{ u: root, i: 0 }]
    color.set(root, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const kids = adj.get(top.u)!
      if (top.i < kids.length) {
        const v = kids[top.i++]
        const c = color.get(v)
        if (c === 1) back.add(`${top.u}->${v}`)
        else if (c === 0) {
          color.set(v, 1)
          stack.push({ u: v, i: 0 })
        }
      } else {
        color.set(top.u, 2)
        topo.push(top.u)
        stack.pop()
      }
    }
  }
  topo.reverse()

  // Target gap: honour an explicit value, else derive it from the model's OWN median
  // forward-edge gap. The framework evens the rhythm but lets the model set the scale —
  // it refines the model's spatial output rather than imposing a constant over it.
  if (gap == null) {
    const gaps: number[] = []
    for (const u of ids) {
      for (const v of adj.get(u)!) {
        if (back.has(`${u}->${v}`)) continue
        const cu = byId.get(u)!
        const cv = byId.get(v)!
        const dx = cv.x + cv.w / 2 - (cu.x + cu.w / 2)
        const dy = cv.y + cv.h / 2 - (cu.y + cu.h / 2)
        const cd = Math.hypot(dx, dy) || 1
        gaps.push(cd - halfExtentAlong(cu, dx / cd, dy / cd) - halfExtentAlong(cv, dx / cd, dy / cd))
      }
    }
    gap = gaps.length ? Math.max(MARGIN, median(gaps)) : 96
  }

  // Forward sweep: place each child off its first parent at the target edge-to-edge gap.
  const placed = new Set<string>()
  for (const u of topo) {
    const cu = byId.get(u)!
    for (const v of adj.get(u)!) {
      if (back.has(`${u}->${v}`) || placed.has(v)) continue
      const cv = byId.get(v)!
      if (!cv.movable) continue
      const ucx = cu.x + cu.w / 2
      const ucy = cu.y + cu.h / 2
      let dx = cv.x + cv.w / 2 - ucx
      let dy = cv.y + cv.h / 2 - ucy
      const L = Math.hypot(dx, dy) || 1
      dx /= L
      dy /= L
      // Snap near-axis directions so chains stay straight and aligned.
      if (Math.abs(dx) < 0.16) {
        dx = 0
        dy = dy >= 0 ? 1 : -1
      } else if (Math.abs(dy) < 0.16) {
        dy = 0
        dx = dx >= 0 ? 1 : -1
      }
      // A horizontal label projects onto the (snapped) edge direction; widen the gap
      // so it fits between the two shapes instead of being clipped by them.
      let effGap = gap
      const lbl = labelOf.get(`${u}->${v}`)
      if (lbl) effGap = Math.max(gap, Math.abs(lbl.w * dx) + Math.abs(lbl.h * dy) + 2 * LABEL_PAD)
      const dist = halfExtentAlong(cu, dx, dy) + effGap + halfExtentAlong(cv, dx, dy)
      cv.x = ucx + dx * dist - cv.w / 2
      cv.y = ucy + dy * dist - cv.h / 2
      placed.add(v)
    }
  }

  const out = new Map<string, Pt>()
  for (const n of nodes) {
    const c = byId.get(n.id)!
    if (c.x !== n.x || c.y !== n.y) out.set(n.id, { x: c.x, y: c.y })
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
  /** Perpendicular bow for an arrow that shares its endpoint pair with siblings
   *  (parallel/antiparallel edges), so they — and their labels — don't overlap. */
  offset?: number
  /** Binding focus per end (see assignPortFocus); endpoints re-solved against a bend
   *  must use the same focus the binding stores, or they'd snap back to centre. */
  startFocus?: number
  endFocus?: number
}): ArrowRoute {
  const { startShape, endShape, start, end, obstacles, gap } = opts
  const offset = opts.offset ?? 0
  const sf = opts.startFocus ?? 0
  const ef = opts.endFocus ?? 0
  const clearance = opts.clearance ?? CLEARANCE

  // Sibling edge between the same pair: bow by the assigned offset at the midpoint.
  // The offset is pre-signed for the arrow's direction (see assignParallelOffsets),
  // so antiparallel edges land on opposite physical sides instead of coinciding.
  if (offset !== 0) {
    const dx = end.x - start.x
    const dy = end.y - start.y
    const L = Math.hypot(dx, dy) || 1
    const base = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    const mid = { x: base.x - (dy / L) * offset, y: base.y + (dx / L) * offset }
    const s = startShape ? solveEndpoint(startShape, sf, gap, mid) : start
    const e = endShape ? solveEndpoint(endShape, ef, gap, mid) : end
    return { start: s, end: e, mid }
  }

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
  const s = startShape ? solveEndpoint(startShape, sf, gap, mid) : start
  const e = endShape ? solveEndpoint(endShape, ef, gap, mid) : end
  return { start: s, end: e, mid }
}

export interface PairedEdge {
  id: string
  from: string
  to: string
}

/**
 * Spread arrows that share an endpoint pair so they (and their labels) don't sit on
 * top of each other. Edges are grouped by their *unordered* pair, so a bidirectional
 * loop (a→b and b→a) counts as one group of two. Each gets a perpendicular bow
 * `offset` for `routeBoundArrow`; the value is signed against a canonical pair
 * direction so antiparallel edges land on opposite physical sides (not the same one).
 * A lone edge gets 0 (stays straight). Returns id → offset.
 */
export function assignParallelOffsets(edges: PairedEdge[], step = 48): Map<string, number> {
  const groups = new Map<string, PairedEdge[]>()
  for (const e of edges) {
    const key = e.from < e.to ? `${e.from} ${e.to}` : `${e.to} ${e.from}`
    const g = groups.get(key)
    if (g) g.push(e)
    else groups.set(key, [e])
  }
  const out = new Map<string, number>()
  for (const group of groups.values()) {
    if (group.length < 2) {
      out.set(group[0].id, 0)
      continue
    }
    const sorted = [...group].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    const n = sorted.length
    sorted.forEach((e, j) => {
      const side = (j - (n - 1) / 2) * step // distinct physical side along the canonical normal
      out.set(e.id, e.from < e.to ? side : -side) // un-flip for reversed edges
    })
  }
  return out
}

/** Binding focus for an arrow's two ends (0 = aim at the shape centre). */
export interface PortFocus {
  start: number
  end: number
}

/**
 * Ids of edges whose straight centre-to-centre path crosses a third box. These get
 * bowed away by routeBoundArrow and so separate on their own — port allocation must
 * NOT count them as crowding a side, or it would needlessly fan (and slant) the clean
 * straight edges that share that side. Mirrors routeBoundArrow's obstacle test.
 */
export function bowedEdges(edges: PairedEdge[], boxes: LayoutBox[]): Set<string> {
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const out = new Set<string>()
  for (const e of edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) continue
    const pa = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
    const pb = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
    for (const o of boxes) {
      if (o.id === e.from || o.id === e.to) continue
      if (segmentHitsBox(pa, pb, o, CLEARANCE)) {
        out.add(e.id)
        break
      }
    }
  }
  return out
}

/** Within-side offset of an azimuth (radians) from a side's outward axis, in degrees. */
function sideOffset(theta: number, side: number): number {
  let d = (theta * 180) / Math.PI - side * 90
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return d
}

/**
 * Distribute the binding focus of arrows that crowd the same side of a shape, so
 * their endpoints fan out along that edge instead of piling onto one contact point.
 *
 * Excalidraw stores where a bound arrow meets a shape as a scalar `focus` (0 = centre;
 * ±|focus| slides the contact toward a corner — see determineFocusPoint in
 * bindingGeometry). For every shape we bucket its incident arrow-ends by which side
 * they exit (the azimuth of the far shape), and on any side carrying ≥2 ends assign
 * evenly-spaced focus values centred on 0 and ordered along the edge, so the fan opens
 * without crossing. A side with a lone end keeps focus 0 — its endpoint sits at the
 * exact edge midpoint where our outline math is most accurate. Arrows that share an
 * unordered pair (a↔b more than once) are left to assignParallelOffsets and skipped
 * here, so the two mechanisms never fight over the same arrows. Edges in `opts.skip`
 * (those that will be bowed around an obstacle — see bowedEdges) are left out entirely:
 * a bowed arrow separates on its own and must not crowd a side. Returns id → PortFocus.
 */
export function assignPortFocus(
  edges: PairedEdge[],
  center: (id: string) => Pt | undefined,
  opts: { step?: number; max?: number; skip?: Set<string> } = {},
): Map<string, PortFocus> {
  const step = opts.step ?? 0.3
  const max = opts.max ?? 0.6
  const skip = opts.skip
  const out = new Map<string, PortFocus>()
  for (const e of edges) out.set(e.id, { start: 0, end: 0 })

  // Skip edges whose unordered pair occurs more than once — assignParallelOffsets
  // separates those (parallel/antiparallel) by bowing, not by moving the endpoint.
  const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`)
  const pairCount = new Map<string, number>()
  for (const e of edges) pairCount.set(pairKey(e.from, e.to), (pairCount.get(pairKey(e.from, e.to)) ?? 0) + 1)

  interface Inc {
    id: string
    end: 'start' | 'end'
    theta: number
  }
  const byShape = new Map<string, Inc[]>()
  const add = (shape: string, inc: Inc) => {
    const list = byShape.get(shape)
    if (list) list.push(inc)
    else byShape.set(shape, [inc])
  }
  for (const e of edges) {
    if (skip?.has(e.id)) continue
    if ((pairCount.get(pairKey(e.from, e.to)) ?? 0) > 1) continue
    const cf = center(e.from)
    const ct = center(e.to)
    if (!cf || !ct) continue
    add(e.from, { id: e.id, end: 'start', theta: Math.atan2(ct.y - cf.y, ct.x - cf.x) })
    add(e.to, { id: e.id, end: 'end', theta: Math.atan2(cf.y - ct.y, cf.x - ct.x) })
  }

  for (const incs of byShape.values()) {
    const sides = new Map<number, Inc[]>()
    for (const inc of incs) {
      const deg = ((inc.theta * 180) / Math.PI + 360) % 360
      const side = Math.round(deg / 90) % 4 // 0 right · 1 bottom · 2 left · 3 top
      const list = sides.get(side)
      if (list) list.push(inc)
      else sides.set(side, [inc])
    }
    for (const [side, group] of sides) {
      if (group.length < 2) continue
      group.sort((a, b) => sideOffset(a.theta, side) - sideOffset(b.theta, side))
      const n = group.length
      group.forEach((inc, j) => {
        const f = Math.max(-max, Math.min(max, (j - (n - 1) / 2) * step))
        const slot = out.get(inc.id)!
        if (inc.end === 'start') slot.start = f
        else slot.end = f
      })
    }
  }
  return out
}
