import { describe, expect, it, vi } from 'vitest'
import type { CanvasPort } from '../protocol'
import type { Conversation } from '../llm'
import { CanvasEngine } from './canvasEngine'

describe('CanvasEngine activity routing', () => {
  it('routes local-agent canvas batches into structured activity', async () => {
    const onActivity = vi.fn()
    const conversation = {
      send: vi.fn(async (_text, _port, callbacks) => {
        callbacks.onToolsApplied('已对画布执行 2/2 个操作')
      }),
    } as unknown as Conversation
    const engine = new CanvasEngine(
      () => conversation,
      () => ({}) as CanvasPort,
    )

    await engine.send('draw', { onText: vi.fn(), onActivity })

    expect(onActivity).toHaveBeenLastCalledWith({ type: 'status', status: 'completed' })
    expect(onActivity).toHaveBeenCalledWith({
      type: 'tool',
      id: 'flowm-canvas-1',
      name: 'Canvas update',
      status: 'completed',
      detail: '已对画布执行 2/2 个操作',
    })
  })

  it('ends a failed harness request and propagates its original error', async () => {
    const onActivity = vi.fn()
    const failure = new Error('Harness request failed')
    const conversation = { send: vi.fn().mockRejectedValue(failure) } as unknown as Conversation
    const engine = new CanvasEngine(() => conversation, () => ({}) as CanvasPort)

    await expect(engine.send('draw', { onText: vi.fn(), onActivity })).rejects.toBe(failure)
    expect(onActivity).toHaveBeenLastCalledWith({ type: 'status', status: 'failed' })
  })

  it('commits a canvas batch and its opaque feedback before the workflow reports success', async () => {
    const order: string[] = []
    const result = [{ ok: true, op: 'create_geo', id: 'shape' }]
    const port = { apply: async () => { order.push('apply'); return result } } as unknown as CanvasPort
    const conversation = { send: async (_text: string, surface: CanvasPort) => {
      await surface.apply([])
      order.push('feedback')
    } } as unknown as Conversation
    const record = vi.fn(async () => { order.push('journal') })
    const engine = new CanvasEngine(() => conversation, () => port, async () => { order.push('save') }, record)
    await engine.send('Draw', { onText: vi.fn() })
    expect(order).toEqual(['apply', 'save', 'journal', 'feedback'])
    expect(record).toHaveBeenCalledWith(result)
  })
})
