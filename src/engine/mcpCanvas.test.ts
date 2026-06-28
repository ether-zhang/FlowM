import { describe, it, expect, vi } from 'vitest'
import { handleMcpRequest } from './mcpCanvas'
import type { CanvasPort, CanvasShape, CanvasOp, OpResult } from '../protocol'

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakePort(over: Partial<CanvasPort> = {}): CanvasPort {
  return {
    snapshot: () => [],
    selectionScope: () => null,
    apply: async () => [],
    exportImage: async () => null,
    serialize: () => null,
    deserialize: () => {},
    ...over,
  }
}

describe('handleMcpRequest', () => {
  it('lists the canvas tools (get_canvas + ops + declare_structure)', async () => {
    const res = (await handleMcpRequest('tools/list', {}, fakePort())) as { tools: { name: string }[] }
    const names = res.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['get_canvas', 'create_geo', 'connect_shapes', 'declare_structure']))
  })

  it('get_canvas returns the requested snapshot as text', async () => {
    const shapes: CanvasShape[] = [{ id: 's1', type: 'rectangle', x: 0, y: 0, w: 120, h: 80, text: 'A' }]
    const snapshot = vi.fn(() => shapes)
    const res = (await handleMcpRequest('tools/call', { name: 'get_canvas', arguments: { scope: 'all' } }, fakePort({ snapshot }))) as {
      content: { text: string }[]
    }
    expect(snapshot).toHaveBeenCalledWith('all')
    expect(res.content[0].text).toContain('s1')
  })

  it('validates and applies a canvas op, returning the result (with the new id)', async () => {
    const apply = vi.fn(async (ops: CanvasOp[]): Promise<OpResult[]> => [{ op: ops[0].op, ok: true, id: 'flowm-x' }])
    const res = (await handleMcpRequest('tools/call', { name: 'create_geo', arguments: { shape: 'rectangle', x: 10, y: 20 } }, fakePort({ apply }))) as {
      content: { text: string }[]
    }
    expect((apply.mock.calls[0][0][0] as any).op).toBe('create_geo')
    expect(res.content[0].text).toContain('flowm-x')
  })

  it('declare_structure applies a scope with no ops', async () => {
    const apply = vi.fn(async (_ops: CanvasOp[], _scope?: unknown): Promise<OpResult[]> => [])
    await handleMcpRequest('tools/call', { name: 'declare_structure', arguments: { relations: [{ kind: 'flow', nodes: ['a', 'b'] }] } }, fakePort({ apply }))
    expect(apply.mock.calls[0][0]).toEqual([]) // empty ops batch
    expect(apply.mock.calls[0][1]).toBeTruthy() // a resolved scope
  })

  it('returns an error result (not a throw) for an invalid op or missing port', async () => {
    const bad = (await handleMcpRequest('tools/call', { name: 'create_geo', arguments: { shape: 'blob' } }, fakePort())) as { isError?: boolean }
    expect(bad.isError).toBe(true)
    const noPort = (await handleMcpRequest('tools/call', { name: 'get_canvas', arguments: {} }, null)) as { isError?: boolean }
    expect(noPort.isError).toBe(true)
  })
})
