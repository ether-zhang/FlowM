import { describe, expect, it, vi } from 'vitest'
import type { CanvasOp, CanvasPort, CanvasShape, LayoutScope, OpResult } from '../protocol'
import type { CanvasTurnRuntime, RunTurnParams, TurnCallbacks } from './canvasTurn'
import { Conversation } from './conversation'
import type { LlmMessage, LlmTurn } from './types'

class ScriptedRuntime implements CanvasTurnRuntime {
  readonly requests: Array<RunTurnParams & { messages: LlmMessage[] }> = []
  readonly dispose = vi.fn(async () => undefined)
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

describe('canvas request cancellation boundary', () => {
  it('discards a late model result before it reaches CanvasPort', async () => {
    let resolveTurn!: (turn: LlmTurn) => void
    const adapter: CanvasTurnRuntime = { runTurn: () => new Promise((resolve) => { resolveTurn = resolve }), cancel: vi.fn(async () => {}) }
    const conversation = new Conversation(adapter)
    const { port, apply } = createPort()
    const send = conversation.send('Draw', port, callbacks())
    const cancelled = expect(send).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(resolveTurn).toBeTypeOf('function'))
    await conversation.cancel()
    resolveTurn({ text: 'late', toolCalls: [{ id: 'late', name: 'create_text', args: { text: 'late', x: 0, y: 0 } }] })
    await cancelled
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('Conversation turn contract', () => {
  it('keeps structure and freeze constraints across build batches before running intent repair', async () => {
    const adapter = new ScriptedRuntime([
      { text: '', toolCalls: [{ id: 'flow', name: 'declare_structure', args: { relations: [{ kind: 'flow', nodes: ['a', 'b'], dir: 'down' }] } }] },
      { text: '', toolCalls: [{ id: 'protect', name: 'declare_structure', args: { relations: [
        { kind: 'align', nodes: ['b', 'c'], axis: 'row' }, { kind: 'freeze', nodes: ['a'] },
      ] } }] },
      { text: 'Done.', toolCalls: [] },
    ])
    const { port, apply } = createPort(['a', 'b', 'c'].map((id) => ({ id, type: 'rectangle', x: 0, y: 0 })))
    await new Conversation(adapter).send('Repair the layout.', port, callbacks())
    expect(apply).toHaveBeenCalledTimes(2)
    const scope = apply.mock.calls[1][1]!
    expect([...scope.spacing]).toEqual(['b'])
    expect(scope.relations).toEqual([
      { kind: 'flow', nodes: ['a', 'b'], dir: 'down' },
      { kind: 'align', nodes: ['b', 'c'], axis: 'row' },
      { kind: 'freeze', nodes: ['a'] },
    ])
  })

  it('returns layout conflicts only after all tool results have been paired', async () => {
    const adapter = new ScriptedRuntime([
      { text: '', toolCalls: [
        { id: 'move', name: 'move_shape', args: { id: 'a', x: 0, y: 10 } },
        { id: 'structure', name: 'declare_structure', args: { relations: [{ kind: 'flow', nodes: ['a', 'b'], dir: 'down' }] } },
      ] },
      { text: 'Built.', toolCalls: [] },
      { text: 'Reviewed.', toolCalls: [] },
      { text: 'Explain the remaining conflict.', toolCalls: [] },
    ])
    const { port } = createPort(['a', 'b'].map((id) => ({ id, type: 'rectangle', x: 0, y: 0 })))
    port.layoutDiagnostics = () => ['Container region cannot accommodate b without changing its size.']
    await new Conversation(adapter).send('Repair this flow.', port, callbacks())
    const messages = adapter.requests[1].messages
    const feedbackIndex = messages.findIndex((message) => message.role === 'user' && message.content.startsWith('FlowM layout diagnostics'))
    expect(feedbackIndex).toBeGreaterThan(0)
    for (const id of ['move', 'structure']) {
      const resultIndex = messages.findIndex((message) => message.role === 'tool' && message.toolCallId === id)
      expect(resultIndex).toBeGreaterThan(0)
      expect(resultIndex).toBeLessThan(feedbackIndex)
    }
    expect(messages[feedbackIndex].content).toContain('cannot accommodate b')
  })
  it('exposes and disposes the adapter-owned session lifecycle', async () => {
    const adapter = new ScriptedRuntime([])
    const conversation = new Conversation(adapter)
    await conversation.dispose()

    expect(adapter.dispose).toHaveBeenCalledOnce()
  })

  it('continues after successful operations, then reviews the changed region', async () => {
    const adapter = new ScriptedRuntime([
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
    const adapter = new ScriptedRuntime([
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
    const adapter = new ScriptedRuntime([
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

  it('compiles a diagram plan before materializing same-batch create refs', async () => {
    const adapter = new ScriptedRuntime([
      {
        text: '',
        toolCalls: [
          {
            id: 'plan',
            name: 'declare_diagram',
            args: {
              kind: 'mixed',
              focus: 'A compact request lifecycle and its storage.',
              regions: [
                {
                  ref: 'runtime',
                  kind: 'process',
                  purpose: 'Request lifecycle.',
                  primaryRefs: ['request', 'allocate'],
                },
                {
                  ref: 'storage',
                  kind: 'structure',
                  purpose: 'Storage ownership.',
                  primaryRefs: ['pool', 'pages'],
                },
              ],
            },
          },
          { id: 'request', name: 'create_geo', args: { shape: 'rectangle', ref: 'request' } },
          { id: 'allocate', name: 'create_geo', args: { shape: 'rectangle', ref: 'allocate' } },
          { id: 'pool', name: 'create_geo', args: { shape: 'rectangle', ref: 'pool' } },
          { id: 'pages', name: 'create_geo', args: { shape: 'rectangle', ref: 'pages' } },
        ],
      },
      { text: 'Built.', toolCalls: [] },
      { text: 'Reviewed.', toolCalls: [] },
      { text: 'Final.', toolCalls: [] },
    ])
    const { port, apply } = createPort()

    await new Conversation(adapter).send('Draw a mixed diagram.', port, callbacks())

    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0]?.[0]).toHaveLength(4)
    expect(adapter.requests[1]?.messages).toContainEqual({
      role: 'tool',
      toolCallId: 'plan',
      content: JSON.stringify({
        ok: true,
        kind: 'mixed',
        regions: 2,
        primary: 4,
        supporting: 0,
      }),
    })
  })

  it('requires a semantic plan for a structured create batch without using a shape-count threshold', async () => {
    const adapter = new ScriptedRuntime([
      {
        text: '',
        toolCalls: [
          { id: 'create-a', name: 'create_geo', args: { shape: 'rectangle', ref: 'a' } },
          { id: 'create-b', name: 'create_geo', args: { shape: 'rectangle', ref: 'b' } },
          {
            id: 'structure',
            name: 'declare_structure',
            args: { relations: [{ kind: 'flow', nodes: ['a', 'b'], dir: 'down' }] },
          },
        ],
      },
      { text: 'Stopped after the plan error.', toolCalls: [] },
    ])
    const { port, apply } = createPort()

    await new Conversation(adapter).send('Draw a non-trivial diagram.', port, callbacks())

    expect(apply).not.toHaveBeenCalled()
    expect(adapter.requests[1]?.messages).toContainEqual({
      role: 'tool',
      toolCallId: 'create-a',
      content: expect.stringContaining(
        'create batch with declare_structure requires one declare_diagram operation',
      ),
    })
  })

  it('rejects an undeclared create ref without partially applying the planned batch', async () => {
    const adapter = new ScriptedRuntime([
      {
        text: '',
        toolCalls: [
          {
            id: 'plan',
            name: 'declare_diagram',
            args: {
              kind: 'process',
              focus: 'A short process.',
              regions: [{
                ref: 'runtime',
                kind: 'process',
                purpose: 'Main flow.',
                primaryRefs: ['a'],
              }],
            },
          },
          { id: 'create-a', name: 'create_geo', args: { shape: 'rectangle', ref: 'a' } },
          { id: 'create-b', name: 'create_geo', args: { shape: 'rectangle', ref: 'b' } },
        ],
      },
      { text: 'Stopped after the ref error.', toolCalls: [] },
    ])
    const { port, apply } = createPort([
      { id: 'a', type: 'rectangle', x: 0, y: 0 },
    ])

    await new Conversation(adapter).send('Draw it.', port, callbacks())

    expect(apply).not.toHaveBeenCalled()
    expect(adapter.requests[1]?.messages).toContainEqual({
      role: 'tool',
      toolCallId: 'create-b',
      content: expect.stringContaining('create ref b is not assigned to a diagram region'),
    })
  })

  it('keeps a plan active across build batches and requests missing refs before completion', async () => {
    const adapter = new ScriptedRuntime([
      {
        text: '',
        toolCalls: [
          {
            id: 'plan',
            name: 'declare_diagram',
            args: {
              kind: 'process',
              focus: 'A four-step process.',
              regions: [{
                ref: 'runtime',
                kind: 'process',
                purpose: 'Main flow.',
                primaryRefs: ['a', 'b', 'c', 'd'],
              }],
            },
          },
          ...['a', 'b', 'c'].map((ref) => ({
            id: `create-${ref}`,
            name: 'create_geo',
            args: { shape: 'rectangle', ref },
          })),
        ],
      },
      { text: 'Initially complete.', toolCalls: [] },
      {
        text: '',
        toolCalls: [{ id: 'create-d', name: 'create_geo', args: { shape: 'rectangle', ref: 'd' } }],
      },
      { text: 'Built.', toolCalls: [] },
      { text: 'Reviewed.', toolCalls: [] },
      { text: 'Final.', toolCalls: [] },
    ])
    const { port, apply } = createPort()

    await new Conversation(adapter).send('Draw four steps.', port, callbacks())

    expect(apply).toHaveBeenCalledTimes(2)
    expect(adapter.requests[2]?.messages).toContainEqual({
      role: 'user',
      content: expect.stringContaining('Materialize these planned shape refs before finishing: d'),
    })
  })

  it('accepts exactly one diagram plan per user turn', async () => {
    const plan = {
      kind: 'process',
      focus: 'Existing process.',
      regions: [{
        ref: 'runtime',
        kind: 'process',
        purpose: 'Main flow.',
        primaryRefs: ['existing-a', 'existing-b'],
      }],
    }
    const adapter = new ScriptedRuntime([
      {
        text: '',
        toolCalls: [
          { id: 'plan-1', name: 'declare_diagram', args: plan },
          { id: 'plan-2', name: 'declare_diagram', args: plan },
        ],
      },
      { text: 'Stopped.', toolCalls: [] },
    ])
    const { port } = createPort([
      { id: 'existing-a', type: 'rectangle', x: 0, y: 0 },
      { id: 'existing-b', type: 'rectangle', x: 200, y: 0 },
    ])

    await new Conversation(adapter).send('Inspect the process.', port, callbacks())

    expect(adapter.requests[1]?.messages).toContainEqual({
      role: 'tool',
      toolCallId: 'plan-2',
      content: 'error: declare_diagram may be accepted only once per user turn',
    })
  })

  it('resolves same-batch refs before realizing a structure declaration', async () => {
    const adapter = new ScriptedRuntime([
      {
        text: '',
        toolCalls: [
          {
            id: 'plan',
            name: 'declare_diagram',
            args: {
              kind: 'process',
              focus: 'A two-step flow.',
              regions: [{
                ref: 'runtime',
                kind: 'process',
                purpose: 'Main flow.',
                primaryRefs: ['a', 'b'],
              }],
            },
          },
          { id: 'create-a', name: 'create_geo', args: { shape: 'rectangle', ref: 'a' } },
          { id: 'create-b', name: 'create_geo', args: { shape: 'rectangle', ref: 'b' } },
          { id: 'connect', name: 'connect_shapes', args: { from: 'a', to: 'b' } },
          {
            id: 'structure',
            name: 'declare_structure',
            args: { relations: [{ kind: 'flow', nodes: ['a', 'b'], dir: 'down' }] },
          },
        ],
      },
      { text: 'Built.', toolCalls: [] },
      { text: 'Reviewed.', toolCalls: [] },
      { text: 'Final.', toolCalls: [] },
    ])
    const { port, apply } = createPort()

    await new Conversation(adapter).send('Draw a flow.', port, callbacks())

    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[0]?.[0]).toHaveLength(3)
    expect(apply.mock.calls[1]?.[0]).toEqual([])
    expect(apply.mock.calls[1]?.[1]).toEqual({
      spacing: new Set(['created-1', 'created-2']),
      overlap: new Set(['created-1', 'created-2']),
      relations: [{ kind: 'flow', nodes: ['created-1', 'created-2'], dir: 'down' }],
    })
  })

  it('resolves same-batch refs before placing a newly created region', async () => {
    const adapter = new ScriptedRuntime([
      {
        text: '',
        toolCalls: [
          { id: 'create-a', name: 'create_geo', args: { shape: 'rectangle', ref: 'a' } },
          { id: 'create-b', name: 'create_geo', args: { shape: 'rectangle', ref: 'b' } },
          {
            id: 'place',
            name: 'place_region',
            args: { ids: ['a', 'b'], anchorId: 'a', prefer: 'right' },
          },
        ],
      },
      { text: 'Built.', toolCalls: [] },
      { text: 'Reviewed.', toolCalls: [] },
      { text: 'Final.', toolCalls: [] },
    ])
    const { port, apply } = createPort()

    await new Conversation(adapter).send('Draw and place a region.', port, callbacks())

    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[1]?.[0]).toEqual([{
      op: 'place_region',
      ids: ['created-1', 'created-2'],
      anchorId: 'created-1',
      prefer: 'right',
    }])
  })

  it('keeps a declaration pending when its refs are created in a later build batch', async () => {
    const adapter = new ScriptedRuntime([
      {
        text: '',
        toolCalls: [{
          id: 'structure',
          name: 'declare_structure',
          args: { relations: [{ kind: 'flow', nodes: ['a', 'b'], dir: 'down' }] },
        }],
      },
      {
        text: '',
        toolCalls: [
          { id: 'create-a', name: 'create_geo', args: { shape: 'rectangle', ref: 'a' } },
          { id: 'create-b', name: 'create_geo', args: { shape: 'rectangle', ref: 'b' } },
          { id: 'connect', name: 'connect_shapes', args: { from: 'a', to: 'b' } },
        ],
      },
      { text: 'Built.', toolCalls: [] },
      { text: 'Reviewed.', toolCalls: [] },
      { text: 'Final.', toolCalls: [] },
    ])
    const { port, apply } = createPort()

    await new Conversation(adapter).send('Declare, then draw.', port, callbacks())

    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[1]?.[0]).toEqual([])
    expect(apply.mock.calls[1]?.[1]).toEqual({
      spacing: new Set(['created-1', 'created-2']),
      overlap: new Set(['created-1', 'created-2']),
      relations: [{ kind: 'flow', nodes: ['created-1', 'created-2'], dir: 'down' }],
    })
    expect(adapter.requests[1]?.messages).toContainEqual({
      role: 'tool',
      toolCallId: 'structure',
      content: JSON.stringify({ ok: true, accepted: 1, resolved: 0, pending: 1, errors: [] }),
    })
  })

  it('surfaces a structured question without applying or reviewing', async () => {
    const adapter = new ScriptedRuntime([
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

  it('shows neighboring context during review but rejects edits outside editable ids', async () => {
    const adapter = new ScriptedRuntime([
      {
        text: '',
        toolCalls: [{
          id: 'create',
          name: 'create_geo',
          args: { shape: 'rectangle', x: 0, y: 0, text: 'New node' },
        }],
      },
      { text: 'Build complete.', toolCalls: [] },
      {
        text: 'Moving the neighbor.',
        toolCalls: [{ id: 'move-existing', name: 'move_shape', args: { id: 'existing', x: 300, y: 0 } }],
      },
      { text: 'Final explanation.', toolCalls: [] },
    ])
    const { port, apply, regionOf } = createPort([
      { id: 'existing', type: 'rectangle', x: 120, y: 0, w: 100, h: 60, text: 'Existing' },
      { id: 'far-sketch', type: 'draw', x: 2_000, y: 2_000, w: 100, h: 100 },
    ])
    regionOf.mockImplementation((ids) => new Set([...ids, 'existing']))
    const cb = callbacks()

    await new Conversation(adapter).send('Add a node.', port, cb)

    expect(adapter.requests[2]?.tools.map((tool) => tool.name)).toEqual([
      'move_shape',
      'place_region',
      'declare_structure',
    ])
    const reviewMessage = adapter.requests[2]?.messages.at(-1)
    expect(reviewMessage).toMatchObject({ role: 'user' })
    expect((reviewMessage as { content: string }).content).toContain('Editable ids: created-1')
    expect((reviewMessage as { content: string }).content).toContain(
      'Context-only ids (do not modify): existing',
    )
    expect((reviewMessage as { content: string }).content).not.toContain('#far-sketch')
    expect(apply).toHaveBeenCalledTimes(1)
    expect(adapter.requests[3]?.messages).toContainEqual({
      role: 'tool',
      toolCallId: 'move-existing',
      content: 'error: review cannot move context-only shape existing',
    })
    expect(cb.onText).toHaveBeenCalledWith('Final explanation.')
  })
})
