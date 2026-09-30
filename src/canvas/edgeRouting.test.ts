import { describe, expect, it } from 'vitest'
import { arrowLabelAnchor, arrowLabelTopLeft, routeNeedsUpdate, routePlannedArrow } from './edgeRouting'
import type { LayoutBox } from './layout'

const box = (id: string, x: number, y: number, w = 100, h = 60): LayoutBox => ({
  id,
  x,
  y,
  w,
  h,
  movable: false,
})

const shape = (item: LayoutBox) => ({
  x: item.x,
  y: item.y,
  width: item.w,
  height: item.h,
  type: 'rectangle',
})

describe('routePlannedArrow', () => {
  it('retains an existing clear route even when a shorter route is available', () => {
    const preferredPoints = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 0 }]
    const route = routePlannedArrow({ start: preferredPoints[0], end: preferredPoints[3], preferredPoints, obstacles: [], gap: 8 })
    expect(route.points).toEqual(preferredPoints)
    expect(route.warnings).toEqual([])
  })

  it('retains the previous direction and reports failure when every route starts inside an obstacle', () => {
    const preferredPoints = [{ x: 0, y: 0 }, { x: 20, y: 50 }, { x: 100, y: 0 }]
    const route = routePlannedArrow({
      start: preferredPoints[0], end: preferredPoints[2], preferredPoints,
      obstacles: [box('enclosing-obstacle', -1000, -1000, 2000, 2000)], gap: 8,
    })
    expect(route.points).toEqual(preferredPoints)
    expect(route.warnings.join(' ')).toContain('No collision-free route')
  })
  it('uses a multi-segment corridor around a third node', () => {
    const startNode = box('start', 0, 0)
    const blocker = box('blocker', 150, -30, 90, 120)
    const endNode = box('end', 320, 0)
    const route = routePlannedArrow({
      startId: 'start',
      endId: 'end',
      startShape: shape(startNode),
      endShape: shape(endNode),
      start: { x: 108, y: 30 },
      end: { x: 312, y: 30 },
      obstacles: [startNode, blocker, endNode],
      gap: 8,
    })

    expect(route.points.length).toBeGreaterThanOrEqual(4)
    const middleYs = route.points.slice(1, -1).map((point) => point.y)
    expect(middleYs.some((y) => y < blocker.y - 10 || y > blocker.y + blocker.h + 10)).toBe(true)
  })

  it('reserves an even-point middle segment for a bound label', () => {
    const startNode = box('start', 0, 0)
    const endNode = box('end', 0, 280)
    const route = routePlannedArrow({
      startId: 'start',
      endId: 'end',
      startShape: shape(startNode),
      endShape: shape(endNode),
      start: { x: 50, y: 68 },
      end: { x: 50, y: 272 },
      obstacles: [startNode, endNode],
      label: { w: 100, h: 24 },
      gap: 8,
    })

    expect(route.points.length % 2).toBe(0)
    expect(route.labelAnchor).toEqual(arrowLabelAnchor(route.points))
    const topLeft = arrowLabelTopLeft(route.points, 100, 24)
    expect(topLeft.y).toBeGreaterThan(startNode.y + startNode.h)
    expect(topLeft.y + 24).toBeLessThan(endNode.y)
  })

  it('treats a previously reserved label as a hard routing obstacle', () => {
    const startNode = box('start', 0, 0)
    const endNode = box('end', 320, 0)
    const reservedLabel = box('label', 155, 15, 100, 30)
    const route = routePlannedArrow({
      startId: 'start',
      endId: 'end',
      startShape: shape(startNode),
      endShape: shape(endNode),
      start: { x: 108, y: 30 },
      end: { x: 312, y: 30 },
      obstacles: [startNode, endNode, reservedLabel],
      gap: 8,
    })

    expect(route.points.every((point) => point.y < reservedLabel.y || point.y > reservedLabel.y + reservedLabel.h)).toBe(true)
  })

  it('keeps a self-loop outside its node instead of collapsing it', () => {
    const item = box('node', 100, 100, 140, 80)
    const route = routePlannedArrow({
      startId: 'node',
      endId: 'node',
      startShape: shape(item),
      endShape: shape(item),
      start: { x: 240, y: 140 },
      end: { x: 240, y: 140 },
      obstacles: [item],
      label: { w: 100, h: 24 },
      gap: 8,
      focus: { start: -0.2, end: 0.2 },
    })

    expect(route.points.length).toBe(4)
    expect(route.points.some((point) => point.x > item.x + item.w || point.x < item.x)).toBe(true)
  })

  it('uses occupied segments to generate a lower-crossing lane', () => {
    const route = routePlannedArrow({
      start: { x: 0, y: 0 },
      end: { x: 300, y: 0 },
      obstacles: [],
      occupied: [{ from: { x: 150, y: -50 }, to: { x: 150, y: 50 } }],
      gap: 8,
    })

    expect(route.points.length).toBeGreaterThan(2)
    expect(route.points.slice(1, -1).some((point) => Math.abs(point.y) > 50)).toBe(true)
  })
})

describe('routeNeedsUpdate', () => {
  const route = { id: 'edge', from: 'a', to: 'b', points: [{ x: 0, y: 30 }, { x: 300, y: 30 }] }
  it('keeps unrelated routes stable and detects a new obstacle across an existing route', () => {
    expect(routeNeedsUpdate(route, new Set(['far']), new Set(), [box('far', 2000, 2000)])).toBe(false)
    expect(routeNeedsUpdate(route, new Set(['blocker']), new Set(), [box('blocker', 100, 0)])).toBe(true)
    expect(routeNeedsUpdate(route, new Set(['a']), new Set(), [])).toBe(true)
    expect(routeNeedsUpdate(route, new Set(), new Set(['edge']), [])).toBe(true)
  })

  it('updates a route when only its existing label is covered by a new shape', () => {
    const labeled = { ...route, label: box('label', 130, 20, 40, 100) }
    const obstacle = box('blocker', 160, 100, 20, 20)
    expect(routeNeedsUpdate(route, new Set(['blocker']), new Set(), [obstacle])).toBe(false)
    expect(routeNeedsUpdate(labeled, new Set(['blocker']), new Set(), [obstacle])).toBe(true)
  })
})

describe('arrowLabelAnchor', () => {
  it('uses the midpoint of the middle segment for an even point count', () => {
    expect(arrowLabelAnchor([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
    ])).toEqual({ x: 100, y: 100 })
  })
})
