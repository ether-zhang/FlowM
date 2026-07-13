import { describe, expect, it, vi } from 'vitest'
import type { CanvasPort } from '../protocol'
import type { Conversation } from '../llm'
import { CanvasEngine } from './canvasEngine'

describe('CanvasEngine activity routing', () => {
  it('routes local-agent canvas batches into structured activity', async () => {
    const onActivity = vi.fn()
    const onSystem = vi.fn()
    const conversation = {
      send: vi.fn(async (_text, _port, callbacks) => {
        callbacks.onToolsApplied('已对画布执行 2/2 个操作')
      }),
    } as unknown as Conversation
    const engine = new CanvasEngine(
      () => conversation,
      () => ({}) as CanvasPort,
      { structuredActivity: true },
    )

    await engine.send('draw', { onText: vi.fn(), onSystem, onActivity })

    expect(onSystem).not.toHaveBeenCalled()
    expect(onActivity).toHaveBeenCalledWith({
      type: 'tool',
      id: 'flowm-canvas-1',
      name: 'Canvas update',
      status: 'completed',
      detail: '已对画布执行 2/2 个操作',
    })
  })

  it('keeps API canvas summaries on the legacy system channel', async () => {
    const onActivity = vi.fn()
    const onSystem = vi.fn()
    const conversation = {
      send: vi.fn(async (_text, _port, callbacks) => {
        callbacks.onToolsApplied('Applied 1/1 canvas operations')
      }),
    } as unknown as Conversation
    const engine = new CanvasEngine(() => conversation, () => ({}) as CanvasPort)

    await engine.send('draw', { onText: vi.fn(), onSystem, onActivity })

    expect(onSystem).toHaveBeenCalledWith('Applied 1/1 canvas operations')
    expect(onActivity).not.toHaveBeenCalled()
  })
})
