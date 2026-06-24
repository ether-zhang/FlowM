import { describe, it, expect } from 'vitest'
import { resolveOverlaps, routeBoundArrow, type LayoutBox } from './layout'
import { type Shape } from './bindingGeometry'

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
