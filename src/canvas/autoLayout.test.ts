import { describe, it, expect } from 'vitest'
import { autoLayout } from './autoLayout'

const box = (id: string) => ({ id, w: 100, h: 60 })

describe('autoLayout', () => {
  it('lays a linear chain down one column (increasing y, shared x)', () => {
    const pos = autoLayout([box('a'), box('b'), box('c')], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ], { x: 0, y: 0 })
    expect(pos.get('a')!.y).toBeLessThan(pos.get('b')!.y)
    expect(pos.get('b')!.y).toBeLessThan(pos.get('c')!.y)
    expect(pos.get('a')!.x).toBe(pos.get('c')!.x) // single column, equal-width → same x
  })

  it('puts a branch on the same layer, side by side', () => {
    const pos = autoLayout([box('a'), box('b'), box('c')], [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
    ], { x: 0, y: 0 })
    expect(pos.get('b')!.y).toBe(pos.get('c')!.y) // same depth → same row
    expect(pos.get('b')!.x).not.toBe(pos.get('c')!.x)
    expect(pos.get('a')!.y).toBeLessThan(pos.get('b')!.y)
  })

  it('lays disconnected components apart (keeps each region together)', () => {
    const pos = autoLayout([box('a'), box('b'), box('c'), box('d')], [
      { from: 'a', to: 'b' }, // region 1
      { from: 'c', to: 'd' }, // region 2 (no edge to region 1)
    ], { x: 0, y: 0 })
    const r1MaxX = Math.max(pos.get('a')!.x, pos.get('b')!.x) + 100
    const r2MinX = Math.min(pos.get('c')!.x, pos.get('d')!.x)
    expect(r2MinX).toBeGreaterThan(r1MaxX) // region 2 sits clear of region 1, no overlap
  })

  it('survives a cycle (back-edge) without piling everything on one spot', () => {
    const pos = autoLayout([box('a'), box('b'), box('c')], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' }, // back-edge
    ], { x: 0, y: 0 })
    expect(pos.get('a')!.y).toBeLessThan(pos.get('c')!.y) // forward chain still layered
  })
})
