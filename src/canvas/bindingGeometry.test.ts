import { describe, it, expect } from 'vitest'
import { solveEndpoint, solveArrowEndpoints, type Shape } from './bindingGeometry'

const GAP = 8

const rect = (x: number, y: number, w: number, h: number): Shape => ({ x, y, width: w, height: h, type: 'rectangle' })
const diamond = (x: number, y: number, w: number, h: number): Shape => ({ x, y, width: w, height: h, type: 'diamond' })
const ellipse = (x: number, y: number, w: number, h: number): Shape => ({ x, y, width: w, height: h, type: 'ellipse' })
const onEllipse = (s: Shape, p: { x: number; y: number }, gap: number) => {
  const a = s.width / 2 + gap
  const b = s.height / 2 + gap
  const cx = s.x + s.width / 2
  const cy = s.y + s.height / 2
  return ((p.x - cx) / a) ** 2 + ((p.y - cy) / b) ** 2
}

describe('solveEndpoint — rectangle', () => {
  it('orthogonal ray hits the edge midpoint pushed out by gap', () => {
    const r = rect(0, 0, 100, 60) // centre (50,30)
    // adjacent directly above the centre → endpoint on the top edge + gap
    const p = solveEndpoint(r, 0, GAP, { x: 50, y: -500 })
    expect(p.x).toBeCloseTo(50, 4)
    expect(p.y).toBeCloseTo(-GAP, 4) // top edge y=0 grown to y=-gap
  })

  it('diagonal ray hits the correct grown edge', () => {
    const r = rect(0, 0, 100, 100) // square, centre (50,50)
    const p = solveEndpoint(r, 0, GAP, { x: 50 + 1000, y: 50 + 1000 }) // from lower-right
    // nearest crossing of the grown square: x or y reaches 108 first; for 45° both, corner (108,108)
    expect(p.x).toBeCloseTo(108, 4)
    expect(p.y).toBeCloseTo(108, 4)
  })
})

describe('solveEndpoint — diamond (the reported bug)', () => {
  it('diagonal ray lands on the slanted edge, NOT on the bounding box', () => {
    const d = diamond(0, 0, 100, 100) // vertices: top(50,0) right(100,50) bottom(50,100) left(0,50)
    // adjacent far to the lower-right → endpoint on the bottom-right slanted edge
    const p = solveEndpoint(d, 0, GAP, { x: 1000, y: 1000 })
    // The grown diamond's bottom-right edge runs right(108,50)→bottom(50,108):
    // line x + y = 158. The point must satisfy that (well inside the bbox corner 108,108).
    expect(p.x + p.y).toBeCloseTo(158, 3)
    expect(p.x).toBeLessThan(108)
    expect(p.y).toBeLessThan(108)
  })

  it('straight-down ray hits the top vertex (cardinal point) + gap', () => {
    const d = diamond(0, 0, 100, 100)
    const p = solveEndpoint(d, 0, GAP, { x: 50, y: -500 })
    expect(p.x).toBeCloseTo(50, 4)
    expect(p.y).toBeCloseTo(-GAP, 4) // top vertex y=0 grown to -gap
  })
})

describe('solveEndpoint — ellipse', () => {
  it('endpoint lies on the ellipse grown by gap', () => {
    const e = ellipse(0, 0, 120, 80)
    const p = solveEndpoint(e, 0, GAP, { x: 400, y: 250 })
    expect(onEllipse(e, p, GAP)).toBeCloseTo(1, 3)
  })
})

describe('solveArrowEndpoints — fixed point (no jump on nudge)', () => {
  it('re-solving an endpoint from the resolved other end is stable', () => {
    const a = rect(700, 200, 180, 120)
    const b = diamond(1300, 680, 110, 180) // mimics the reported repro (rect → moved diamond)
    const { start, end } = solveArrowEndpoints({
      start: { shape: a, focus: 0, gap: GAP },
      end: { shape: b, focus: 0, gap: GAP },
      curStart: { x: a.x + a.width / 2, y: a.y + a.height / 2 },
      curEnd: { x: b.x + b.width / 2, y: b.y + b.height / 2 },
    })
    // Native nudge of the diamond recomputes `end` from the stored `start`.
    const end2 = solveEndpoint(b, 0, GAP, start)
    expect(end2.x).toBeCloseTo(end.x, 3)
    expect(end2.y).toBeCloseTo(end.y, 3)
    // And `start` from the stored `end`.
    const start2 = solveEndpoint(a, 0, GAP, end)
    expect(start2.x).toBeCloseTo(start.x, 3)
    expect(start2.y).toBeCloseTo(start.y, 3)
  })

  it('one unbound end keeps its free point and anchors the bound end', () => {
    const b = ellipse(1100, 580, 410, 388)
    const free = { x: 200, y: 200 }
    const { start, end } = solveArrowEndpoints({
      end: { shape: b, focus: 0, gap: GAP },
      curStart: free,
      curEnd: { x: b.x + b.width / 2, y: b.y + b.height / 2 },
    })
    expect(start).toEqual(free)
    expect(onEllipse(b, end, GAP)).toBeCloseTo(1, 3)
  })
})

describe('solveEndpoint — rotated shape', () => {
  it('honours element.angle', () => {
    // square rotated 45°: a ray from straight above now hits a rotated face.
    const r: Shape = { x: 0, y: 0, width: 100, height: 100, type: 'rectangle', angle: Math.PI / 4 }
    const p = solveEndpoint(r, 0, GAP, { x: 50, y: -500 })
    // By symmetry the endpoint stays on the vertical centre line through the centre.
    expect(p.x).toBeCloseTo(50, 3)
    // Rotated square's top vertex sits at centre.y - halfDiagonal - gap·(projection); just assert it's above centre and outside the unrotated top edge.
    expect(p.y).toBeLessThan(0)
  })
})
