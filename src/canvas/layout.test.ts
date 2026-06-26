import { describe, it, expect } from 'vitest'
import { resolveOverlaps, routeBoundArrow, labelBoxSize, normalizeSpacing, assignParallelOffsets, assignPortFocus, type LayoutBox } from './layout'
import { solveEndpoint, type Shape, type Pt } from './bindingGeometry'

const box = (id: string, x: number, y: number, w: number, h: number, movable = true): LayoutBox => ({ id, x, y, w, h, movable })

/** Min clear gap between two boxes along the axis where they're closest. */
const gapBetween = (a: LayoutBox, b: LayoutBox) => {
  const gapX = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w))
  const gapY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h))
  return Math.max(gapX, gapY)
}
const place = (b: LayoutBox, moves: Map<string, { x: number; y: number }>): LayoutBox => {
  const m = moves.get(b.id)
  return m ? { ...b, x: m.x, y: m.y } : b
}

describe('resolveOverlaps (58 — auto-avoidance)', () => {
  it('leaves non-overlapping boxes untouched', () => {
    const moves = resolveOverlaps([box('a', 0, 0, 100, 60), box('b', 400, 0, 100, 60)])
    expect(moves.size).toBe(0)
  })

  it('leaves a tight-but-clear layout alone (only true overlaps are fixed)', () => {
    // 8px gap, less than the 16px margin, but NOT overlapping — must stay put.
    const moves = resolveOverlaps([box('a', 0, 0, 100, 100), box('b', 108, 0, 100, 100)], { margin: 16 })
    expect(moves.size).toBe(0)
  })

  it('separates two overlapping movable boxes to at least the margin', () => {
    const a = box('a', 0, 0, 100, 100)
    const b = box('b', 40, 10, 100, 100) // overlaps a
    const moves = resolveOverlaps([a, b], { margin: 16 })
    expect(moves.size).toBeGreaterThan(0)
    expect(gapBetween(place(a, moves), place(b, moves))).toBeGreaterThanOrEqual(16 - 1e-6)
  })

  it('moves only the movable box when the other is pinned', () => {
    const pinned = box('p', 0, 0, 100, 100, false)
    const fresh = box('f', 40, 0, 100, 100, true)
    const moves = resolveOverlaps([pinned, fresh])
    expect(moves.has('p')).toBe(false)
    expect(moves.has('f')).toBe(true)
    expect(gapBetween(pinned, place(fresh, moves))).toBeGreaterThanOrEqual(16 - 1e-6)
  })

  it('cannot fix two pinned boxes (leaves them overlapping)', () => {
    const moves = resolveOverlaps([box('a', 0, 0, 100, 100, false), box('b', 40, 0, 100, 100, false)])
    expect(moves.size).toBe(0)
  })

  it('converges a stack of three movable boxes to pairwise-clear', () => {
    const boxes = [box('a', 0, 0, 100, 100), box('b', 20, 20, 100, 100), box('c', 40, 40, 100, 100)]
    const moves = resolveOverlaps(boxes, { margin: 16 })
    const placed = boxes.map((b) => place(b, moves))
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++)
        expect(gapBetween(placed[i], placed[j])).toBeGreaterThanOrEqual(16 - 1e-6)
  })
})

describe('routeBoundArrow (59 — bow only around a blocker)', () => {
  const rect = (x: number, y: number, w: number, h: number): Shape => ({ x, y, width: w, height: h, type: 'rectangle' })

  it('keeps a straight line when nothing blocks it', () => {
    const r = routeBoundArrow({ start: { x: 0, y: 50 }, end: { x: 300, y: 50 }, obstacles: [], gap: 8 })
    expect(r.mid).toBeNull()
    expect(r.start).toEqual({ x: 0, y: 50 })
    expect(r.end).toEqual({ x: 300, y: 50 })
  })

  it('bows to clear an obstacle sitting on the straight path', () => {
    // Horizontal arrow at y=50; a box straddles the line near the middle.
    const blocker = box('o', 130, 30, 40, 40) // covers y∈[30,70], on the line
    const r = routeBoundArrow({ start: { x: 0, y: 50 }, end: { x: 300, y: 50 }, obstacles: [blocker], gap: 8, clearance: 10 })
    expect(r.mid).not.toBeNull()
    // apex must sit clear of the blocker box (outside its vertical extent)
    const apex = r.mid!
    expect(apex.y > blocker.y + blocker.h || apex.y < blocker.y).toBe(true)
    expect(Math.abs(apex.y - 50)).toBeGreaterThanOrEqual(blocker.h / 2)
  })

  it('ignores a box that the straight segment does not cross', () => {
    const offside = box('o', 130, 200, 40, 40) // far below the line
    const r = routeBoundArrow({ start: { x: 0, y: 50 }, end: { x: 300, y: 50 }, obstacles: [offside], gap: 8 })
    expect(r.mid).toBeNull()
  })

  it('re-solves a bound endpoint onto the shape outline when bowing', () => {
    const startShape = rect(0, 0, 80, 80) // centre (40,40)
    const blocker = box('o', 200, 20, 40, 40)
    const r = routeBoundArrow({
      startShape,
      start: { x: 80, y: 40 },
      end: { x: 400, y: 40 },
      obstacles: [blocker],
      gap: 8,
      clearance: 10,
    })
    expect(r.mid).not.toBeNull()
    // start re-solved against the bend: still outside the shape (gap away), not the raw input
    expect(r.start.x).toBeGreaterThan(startShape.x + startShape.width) // right of the rect + gap
  })
})

describe('assignParallelOffsets + routeBoundArrow (same-pair separation)', () => {
  const rect = (x: number, y: number, w: number, h: number): Shape => ({ x, y, width: w, height: h, type: 'rectangle' })

  it('a lone edge gets no offset (stays straight)', () => {
    expect(assignParallelOffsets([{ id: 'e', from: 'a', to: 'b' }]).get('e')).toBe(0)
  })

  it('routes an antiparallel loop (a→b, b→a) onto opposite sides', () => {
    const a = rect(0, 0, 80, 80)
    const b = rect(300, 0, 80, 80)
    const offs = assignParallelOffsets([{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'a' }])
    const r1 = routeBoundArrow({ startShape: a, endShape: b, start: { x: 80, y: 40 }, end: { x: 300, y: 40 }, obstacles: [], gap: 8, offset: offs.get('e1')! })
    const r2 = routeBoundArrow({ startShape: b, endShape: a, start: { x: 300, y: 40 }, end: { x: 80, y: 40 }, obstacles: [], gap: 8, offset: offs.get('e2')! })
    expect(r1.mid).not.toBeNull()
    expect(r2.mid).not.toBeNull()
    expect(Math.sign(r1.mid!.y - 40)).toBe(-Math.sign(r2.mid!.y - 40)) // opposite sides of the line
  })

  it('spreads two parallel edges onto opposite sides too', () => {
    const a = rect(0, 0, 80, 80)
    const b = rect(300, 0, 80, 80)
    const offs = assignParallelOffsets([{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'a', to: 'b' }])
    const mk = (id: string) =>
      routeBoundArrow({ startShape: a, endShape: b, start: { x: 80, y: 40 }, end: { x: 300, y: 40 }, obstacles: [], gap: 8, offset: offs.get(id)! })
    const r1 = mk('e1')
    const r2 = mk('e2')
    expect(Math.sign(r1.mid!.y - 40)).toBe(-Math.sign(r2.mid!.y - 40))
  })
})

describe('assignPortFocus (① — multi-port distribution)', () => {
  const T: Shape = { x: 0, y: 0, width: 100, height: 60, type: 'rectangle' }
  const centerOf = (m: Record<string, Pt>) => (id: string) => m[id]

  it('leaves a lone edge centre-aimed (focus 0 both ends)', () => {
    const f = assignPortFocus([{ id: 'e', from: 'a', to: 'b' }], centerOf({ a: { x: 0, y: 0 }, b: { x: 0, y: 200 } }))
    expect(f.get('e')).toEqual({ start: 0, end: 0 })
  })

  it('fans three edges crowding one side onto distinct contact points', () => {
    // three sources stacked directly below t → identical azimuth; centre-aimed (focus 0)
    // all three would meet t's bottom edge at the same x≈50. Port focus must spread them.
    const centers = { t: { x: 50, y: 30 }, s1: { x: 50, y: 200 }, s2: { x: 50, y: 400 }, s3: { x: 50, y: 600 } }
    const edges = [
      { id: 'e1', from: 's1', to: 't' },
      { id: 'e2', from: 's2', to: 't' },
      { id: 'e3', from: 's3', to: 't' },
    ]
    const focus = assignPortFocus(edges, centerOf(centers))
    const contactX = (id: string, src: Pt) => solveEndpoint(T, focus.get(id)!.end, 8, src).x
    const xs = [contactX('e1', centers.s1), contactX('e2', centers.s2), contactX('e3', centers.s3)]
    expect(new Set(xs.map((x) => Math.round(x))).size).toBe(3) // three distinct contact points
    expect(xs[1]).toBeCloseTo(50, 0) // the middle slot stays centre-aimed
  })

  it('leaves same-pair arrows to assignParallelOffsets (focus 0)', () => {
    const f = assignPortFocus(
      [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'a', to: 'b' }],
      centerOf({ a: { x: 0, y: 0 }, b: { x: 0, y: 200 } }),
    )
    expect(f.get('e1')).toEqual({ start: 0, end: 0 })
    expect(f.get('e2')).toEqual({ start: 0, end: 0 })
  })
})

describe('labelBoxSize (67 — content-driven size)', () => {
  it('grows height with line count', () => {
    expect(labelBoxSize('a\nb\nc', 'rectangle').h).toBeGreaterThan(labelBoxSize('hello', 'rectangle').h)
  })

  it('CJK text is wider than the same number of ASCII chars', () => {
    expect(labelBoxSize('结束判断符', 'rectangle').w).toBeGreaterThan(labelBoxSize('abcde', 'rectangle').w)
  })

  it('a diamond needs a bigger box than a rectangle for the same text', () => {
    const r = labelBoxSize('结束?', 'rectangle')
    const d = labelBoxSize('结束?', 'diamond')
    expect(d.w).toBeGreaterThan(r.w)
    expect(d.h).toBeGreaterThan(r.h)
  })
})

describe('normalizeSpacing (2 — edge-direction gap rhythm)', () => {
  const node = (id: string, x: number, y: number, w = 100, h = 60, movable = true): LayoutBox => ({ id, x, y, w, h, movable })

  it('evens a vertical chain to the target gap and aligns the column', () => {
    const a = node('a', 100, 0)
    const b = node('b', 118, 200) // small near-axis x jitter (~5°), gap 140
    const c = node('c', 85, 360)
    const moves = normalizeSpacing([a, b, c], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], { gap: 100 })
    expect(moves.has('a')).toBe(false) // source anchored
    const pb = moves.get('b')!
    expect(pb.y).toBeCloseTo(a.y + a.h + 100, 6) // edge-to-edge gap = 100
    expect(pb.x).toBeCloseTo(a.x, 6) // snapped to a's column
    const pc = moves.get('c')!
    expect(pc.y).toBeCloseTo(pb.y + b.h + 100, 6)
    expect(pc.x).toBeCloseTo(pb.x, 6)
  })

  it('evens a horizontal chain and aligns the row', () => {
    const a = node('a', 0, 100)
    const b = node('b', 200, 130)
    const pb = normalizeSpacing([a, b], [{ from: 'a', to: 'b' }], { gap: 80 }).get('b')!
    expect(pb.x).toBeCloseTo(a.x + a.w + 80, 6)
    expect(pb.y).toBeCloseTo(a.y, 6) // snapped to a's row
  })

  it('skips back-edges so a loop-back does not drag the source', () => {
    const nodes = [node('a', 100, 0), node('b', 100, 300), node('c', 100, 600)]
    const moves = normalizeSpacing(
      nodes,
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }],
      { gap: 100 },
    )
    expect(moves.has('a')).toBe(false) // c->a is a back-edge, ignored
    expect(moves.get('b')!.y).toBeCloseTo(0 + 60 + 100, 6)
  })

  it('never moves a pinned (non-movable) child', () => {
    const moves = normalizeSpacing(
      [node('a', 0, 0), node('b', 40, 300, 100, 60, false)],
      [{ from: 'a', to: 'b' }],
      { gap: 100 },
    )
    expect(moves.has('b')).toBe(false)
  })

  it('widens a labeled near-horizontal edge so the long label fits in the gap', () => {
    const a = node('a', 0, 100)
    const b = node('b', 300, 110) // near-horizontal → snaps to a's row
    const labeled = normalizeSpacing([a, b], [{ from: 'a', to: 'b', labelW: 200, labelH: 24 }], { gap: 80 }).get('b')!
    const plain = normalizeSpacing([a, b], [{ from: 'a', to: 'b' }], { gap: 80 }).get('b')!
    expect(labeled.x).toBeGreaterThan(plain.x) // pushed out to make room for the label
    expect(labeled.x - (a.x + a.w)).toBeGreaterThanOrEqual(200) // edge-to-edge gap >= label width
  })

  it('defaults the target gap to the model’s own median gap (scale stays the model’s)', () => {
    // model gaps: a->b = 100, b->c = 140 → median 120; the framework evens both to 120.
    const a = node('a', 100, 0, 100, 60) // bottom 60
    const b = node('b', 100, 160, 100, 60) // gap 160-60 = 100; bottom 220
    const c = node('c', 100, 360, 100, 60) // gap 360-220 = 140
    const moves = normalizeSpacing([a, b, c], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]) // no gap → median
    const pb = moves.get('b')!
    const cy = moves.get('c')?.y ?? c.y // c may already sit at the median gap → not in moves
    expect(pb.y - (a.y + a.h)).toBeCloseTo(120, 6)
    expect(cy - (pb.y + b.h)).toBeCloseTo(120, 6)
  })

  it('does not widen a labeled vertical edge (the label is orthogonal there)', () => {
    const a = node('a', 100, 0)
    const b = node('b', 100, 200)
    const labeled = normalizeSpacing([a, b], [{ from: 'a', to: 'b', labelW: 200, labelH: 24 }], { gap: 80 }).get('b')!
    const plain = normalizeSpacing([a, b], [{ from: 'a', to: 'b' }], { gap: 80 }).get('b')!
    expect(labeled.y).toBeCloseTo(plain.y, 6)
  })
})
