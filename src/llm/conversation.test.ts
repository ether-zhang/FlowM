import { describe, expect, it, vi } from 'vitest'
import type { CanvasOp, CanvasPort, CanvasShape, LayoutScope, OpResult } from '../protocol'
import type { LlmAdapter, RunTurnParams, TurnCallbacks } from './adapter'
import { Conversation } from './conversation'
import type { LlmMessage, LlmTurn } from './types'

class ScriptedAdapter implements LlmAdapter {
  readonly requests: Array<RunTurnParams & { messages: LlmMessage[] }> = []
  private readonly turns: LlmTurn[]

  constructor(turns: LlmTurn[]) {
    this.turns = turns
  }

  async runTurn(params: RunTurnParams, callbacks: TurnCallbacks): Promise<LlmTurn> {
    void callbacks
    this.requests.push({
      ...params,
      messages: structuredClone(params.messages),
    })
    const turn = this.turns[this.requests.length - 1]
    if (!turn) throw new Error(`Unexpected turn ${this.requests.length}`)
    return turn
  }
}

function createPort(initial: CanvasShape[] = []) {
  const shapes = [...initial]
  let created = 0
  const apply = vi.fn(async (ops: CanvasOp[], scope?: LayoutScope | null): Promise<OpResult[]> => {
    void scope
    return ops.map((op) => {
      if (op.op === 'create_geo') {
        const id = `created-${++created}`
        shapes.push({
          id,
          type: op.shape,
          x: op.x ?? 0,
          y: op.y ?? 0,
          w: op.w,
          h: op.h,
          text: op.text,
        })
        return { op: op.op, ok: true, id, ref: op.ref }
      }
      return { op: op.op, ok: true, id: 'id' in op ? op.id : undefined }
    })
  })
  const regionOf = vi.fn((ids: ReadonlySet<string>) => new Set(ids))
  const exportImage = vi.fn(async (
    scope: 'selection' | 'all',
    _marks?: Map<string, number>,
    ids?: ReadonlySet<string>,
  ) => (scope === 'all' && ids?.size ? 'data:image/png;base64,review' : null))
  const port: CanvasPort = {
    snapshot(_scope, ids) {
      return ids ? shapes.filter((shape) => ids.has(shape.id)) : [...shapes]
    },
    selectionScope: () => null,
    regionOf,
    apply,
    exportImage,
    serialize: () => [],
    deserialize: () => undefined,
  }
  return { port, apply, regionOf, exportImage }
}

const callbacks = () => ({
  onText: vi.fn(),
  onToolsApplied: vi.fn(),
  onQuestion: vi.fn(),
})

describe('Conversation turn contract', () => {
  it('continues after successful operations, then reviews the changed region', async () => {
    const adapter = new ScriptedAdapter([
      {
        text: 'Creating the node.',
        toolCalls: [{
          id: 'create-1',
          name: 'create_geo',
          args: { shape: 'rectangle', x: 10, y: 20, text: 'Scheduler', ref: 'scheduler' },
        }],
      },
      { text: 'Build complete.', toolCalls: [] },
      { text: 'Review complete.', toolCalls: [] },
      { text: 'Final explanation.', toolCalls: [] },
    ])
    const { port, apply, regionOf, exportImage } = createPort()
    const cb = callbacks()

    await new Conversation(adapter).send('Draw a scheduler.', port, cb)

    expect(adapter.requests.map((request) => request.phase)).toEqual([
      'build',
      'build',
      'review',
      'finalize',
    ])
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0]?.[0]).toEqual([
      {
        op: 'create_geo',
        shape: 'rectangle',
        x: 10,
        y: 20,
        text: 'Scheduler',
        ref: 'scheduler',
      },
    ])
    expect(adapter.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'create-1',
    })
    expect(regionOf).toHaveBeenCalledWith(new Set(['created-1']))
    expect(exportImage).toHaveBeenLastCalledWith(
      'all',
      expect.any(Map),
      new Set(['created-1']),
    )
    expect(adapter.requests[2]?.messages.at(-1)).toMatchObject({ role: 'user' })
    expect(adapter.requests[3]?.tools).toEqual([])
    expect(cb.onText).toHaveBeenCalledTimes(1)
    expect(cb.onText).toHaveBeenCalledWith('Final explanation.')
    expect(cb.onToolsApplied).toHaveBeenCalledWith('已对画布执行 1/1 个操作')
  })

  it('returns invalid operation errors to the adapter for self-correction', async () => {
    const adapter = new ScriptedAdapter([
      {
        text: '',
        toolCalls: [{ id: 'bad-move', name: 'move_shape', args: { id: 'missing-y', x: 10 } }],
      },
      { text: 'Stopped after seeing the validation error.', toolCalls: [] },
    ])
    const { port, apply, regionOf } = createPort()
    const cb = callbacks()

    await new Conversation(adapter).send('Move it.', port, cb)

    expect(adapter.requests).toHaveLength(2)
    expect(apply).not.toHaveBeenCalled()
    expect(adapter.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'bad-move',
    })
    expect((adapter.requests[1]?.messages.at(-1) as { content: string }).content).toMatch(/^error:/)
    expect(regionOf).not.toHaveBeenCalled()
    expect(cb.onText).toHaveBeenCalledTimes(1)
    expect(cb.onText).toHaveBeenCalledWith('Stopped after seeing the validation error.')
  })

  it('resolves create refs used by a later operation batch', async () => {
    const adapter = new ScriptedAdapter([
      {
        text: '',
        toolCalls: [
          { id: 'create-a', name: 'create_geo', args: { shape: 'rectangle', x: 0, y: 0, ref: 'a' } },
          { id: 'create-b', name: 'create_geo', args: { shape: 'rectangle', x: 200, y: 0, ref: 'b' } },
        ],
      },
      {
        text: '',
        toolCalls: [{ id: 'connect', name: 'connect_shapes', args: { from: 'a', to: 'b' } }],
      },
      { text: 'Done.', toolCalls: [] },
      { text: 'Reviewed.', toolCalls: [] },
      { text: 'Final explanation.', toolCalls: [] },
    ])
    const { port, apply } = createPort()

    await new Conversation(adapter).send('Connect two nodes.', port, callbacks())

    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[1]?.[0]).toEqual([
      { op: 'connect_shapes', from: 'created-1', to: 'created-2' },
    ])
    expect(adapter.requests.map((request) => request.phase)).toEqual([
      'build',
      'build',
      'build',
      'review',
      'finalize',
    ])
  })

  it('surfaces a structured question without applying or reviewing', async () => {
    const adapter = new ScriptedAdapter([
      {
        text: '',
        toolCalls: [],
        question: {
          items: [{ id: 'direction', prompt: 'Lay this out vertically?', allowOther: true }],
        },
      },
    ])
    const { port, apply, regionOf } = createPort()
    const cb = callbacks()

    await new Conversation(adapter).send('Draw it.', port, cb)

    expect(cb.onQuestion).toHaveBeenCalledWith({
      items: [{ id: 'direction', prompt: 'Lay this out vertically?', allowOther: true }],
    })
    expect(apply).not.toHaveBeenCalled()
    expect(regionOf).not.toHaveBeenCalled()
  })
})
