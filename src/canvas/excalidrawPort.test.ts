import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { resolveScope } from '../protocol'
import { createExcalidrawPort } from './excalidrawPort'
import { clearLayoutTraces, readLayoutTraces } from './layoutTrace'

// Exercise the real port, passes and geometry with a scene-only editor boundary.
vi.mock('@excalidraw/excalidraw', () => ({
  getNonDeletedElements: (elements: Array<{ isDeleted?: boolean }>) => elements.filter((element) => !element.isDeleted),
  newElementWith: (element: object, update: object) => ({ ...element, ...update }),
  convertToExcalidrawElements: (elements: object[]) => elements,
  exportToCanvas: vi.fn(),
}))

const box = (id: string, x: number, y: number, width = 100, height = 60) =>
  ({ id, type: 'rectangle', x, y, width, height, angle: 0, isDeleted: false, boundElements: [] }) as unknown as ExcalidrawElement
const arrow = (id: string, from: string, to: string, x = 108, y = 30, points = [[0, 0], [0, 120], [184, 120], [184, 0]]) => ({
  id, type: 'arrow', x, y, width: 184, height: 120, points, angle: 0, isDeleted: false,
  startBinding: { elementId: from, focus: 0, gap: 8 }, endBinding: { elementId: to, focus: 0, gap: 8 },
  roundness: null, boundElements: [],
}) as unknown as ExcalidrawElement

function editor(initial: ExcalidrawElement[]) {
  let scene = structuredClone(initial)
  const api = {
    getSceneElements: () => scene,
    getAppState: () => ({ selectedElementIds: {} }),
    updateScene: ({ elements }: { elements: ExcalidrawElement[] }) => { scene = elements },
  } as unknown as ExcalidrawImperativeAPI
  return { port: createExcalidrawPort(api), scene: () => scene, get: (id: string) => scene.find((element) => element.id === id)! }
}

beforeEach(clearLayoutTraces)

describe('canvas port layout preservation', () => {
  it('keeps unrelated existing arrow geometry unchanged when another region moves', async () => {
    const route = arrow('ab', 'a', 'b')
    const { port, get } = editor([box('a', 0, 0), box('b', 300, 0), route, box('far', 1500, 0)])
    await port.apply([{ op: 'move_shape', id: 'far', x: 1700, y: 200 }])
    expect(get('ab')).toEqual(route)
  })

  it('preserves every bend when both endpoints translate together', async () => {
    const route = arrow('ab', 'a', 'b')
    const { port, get } = editor([box('a', 0, 0), box('b', 300, 0), route])
    await port.apply([
      { op: 'move_shape', id: 'a', x: 200, y: 200 },
      { op: 'move_shape', id: 'b', x: 500, y: 200 },
    ])
    expect(get('ab')).toMatchObject({ ...route, x: 308, y: 230 })
  })

  it('reattaches a moved endpoint while retaining the existing interior bends', async () => {
    const { port, get } = editor([box('a', 0, 0), box('b', 300, 0), arrow('ab', 'a', 'b')])
    await port.apply([{ op: 'move_shape', id: 'b', x: 300, y: 40 }])
    const route = get('ab')
    expect(route.type).toBe('arrow')
    if (route.type !== 'arrow') return
    const absolute = route.points.map(([x, y]) => ({ x: route.x + x, y: route.y + y }))
    expect(absolute.slice(1, -1)).toEqual([{ x: 108, y: 150 }, { x: 292, y: 150 }])
    expect(absolute.at(-1)).not.toEqual({ x: 292, y: 30 })
  })

  it('preserves a row through the real overlap pass and records before/after stages', async () => {
    const { port, get } = editor([box('a', 0, 0), box('b', 200, 0), box('c', 400, 0), box('obstacle', 220, 40, 60, 60)])
    await port.apply([], resolveScope([{ kind: 'nonOverlap', nodes: ['a', 'b', 'c'] }]))
    expect(['a', 'b', 'c'].map((id) => get(id).y)).toEqual([-36, -36, -36])
    const trace = readLayoutTraces().at(-1)!
    expect(trace.stages.map((stage) => stage.name)).toEqual(['before', 'materialized', 'overlap', 'routing'])
    expect(trace.stages[1].elements.find((element) => element.id === 'b')?.y).toBe(0)
    expect(trace.stages[2].elements.find((element) => element.id === 'b')?.y).toBe(-36)
    expect(port.layoutDiagnostics?.()).toEqual([])
  })

  it('retains a fixed-size container and its children when a spacing proposal cannot fit', async () => {
    const initial = [box('parent', 0, 0, 200, 180), box('a', 40, 20), box('b', 40, 100), arrow('ab', 'a', 'b', 90, 88, [[0, 0], [0, 4]])]
    const { port, get } = editor(initial)
    await port.apply([], resolveScope([
      { kind: 'flow', nodes: ['a', 'b'], dir: 'down' },
      { kind: 'contain', parent: 'parent', children: ['a', 'b'] },
    ]))
    expect(get('parent')).toEqual(initial[0])
    expect(get('a')).toEqual(initial[1])
    expect(get('b')).toEqual(initial[2])
    const rejected = readLayoutTraces().at(-1)!.stages.find((stage) => stage.name === 'spacing')!
    expect(rejected.accepted).toBe(false)
    expect(rejected.issues.join(' ')).toContain('Container parent cannot accommodate b')
    expect(rejected.candidate?.find((item) => item.id === 'b')?.y).toBe(152)
    expect(port.layoutDiagnostics?.().join(' ')).toContain('needs 72px')
  })

  it('keeps the structural region intact while expanding an adjacent process region', async () => {
    const structure = [box('region', 0, 0, 600, 300), box('left', 40, 60), box('right', 240, 60)]
    const { port, get } = editor([
      ...structure, box('start', 800, 0), box('end', 800, 80),
      arrow('process', 'start', 'end', 850, 68, [[0, 0], [0, 4]]),
      arrow('mapping', 'right', 'end', 348, 90, [[0, 0], [444, 20]]),
    ])
    await port.apply([], resolveScope([
      { kind: 'flow', nodes: ['start', 'end'], dir: 'down' },
      { kind: 'contain', parent: 'region', children: ['left', 'right'] },
      { kind: 'nonOverlap', nodes: ['left', 'right', 'start', 'end'] },
    ]))
    for (const item of structure) expect(get(item.id)).toEqual(item)
    expect(get('end')).toMatchObject({ x: 800, y: 132 })
    expect(readLayoutTraces().at(-1)!.stages.filter((stage) => stage.name === 'spacing' || stage.name === 'overlap').every((stage) => stage.accepted)).toBe(true)
  })
})
