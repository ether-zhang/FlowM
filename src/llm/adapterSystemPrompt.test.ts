import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunTurnParams } from './adapter'

const mocks = vi.hoisted(() => ({
  claudeOptions: vi.fn(),
  writeClaudeGuide: vi.fn(async () => '.flowm/claude-canvas.md'),
  writeCodexGuide: vi.fn(async () => '.flowm/codex-canvas.md'),
  writeDesign: vi.fn(async () => '.flowm/design.png'),
  claudeRunTurn: vi.fn(async () => ({
    structured: { operations: [] },
    prose: '',
  })),
  codexRunTurn: vi.fn(async () => JSON.stringify({
    reply: 'Done.',
    question: null,
    operations: [],
  })),
}))

vi.mock('../agent/projectFiles', () => ({
  writeClaudeCanvasGuide: mocks.writeClaudeGuide,
  writeCodexCanvasGuide: mocks.writeCodexGuide,
  writeDesign: mocks.writeDesign,
}))

vi.mock('./claudeTransport', () => ({
  CompatibleClaudeTransport: class {
    constructor(options: unknown) { mocks.claudeOptions(options) }
    readonly kind = 'control'
    readonly sessionId = 'claude-session'

    runTurn = mocks.claudeRunTurn
    answerQuestion = vi.fn(async () => undefined)
    dispose = vi.fn(async () => undefined)
  },
}))

vi.mock('../agentControl', () => ({
  CodexAppServerClient: class {
    readonly threadId = 'codex-thread'

    runTurn = mocks.codexRunTurn
    answerQuestion = vi.fn(async () => undefined)
    dispose = vi.fn(async () => undefined)
  },
}))

import { ClaudeAdapter } from './claudeAdapter'
import { CodexAdapter } from './codexAdapter'

function params(system: string, content = 'Draw it.'): RunTurnParams {
  return {
    phase: 'build',
    system,
    messages: [{ role: 'user', content }],
    tools: [],
  }
}

describe('provider system prompt boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports invalid Codex JSON and retains the unsent delta for the next attempt', async () => {
    const adapter = new CodexAdapter(() => '/project', () => 'codex')
    mocks.codexRunTurn.mockResolvedValueOnce('{"reply":"unfinished"')
    await expect(adapter.runTurn(params('CONTRACT', 'Original request.'), {})).rejects.toThrow('invalid canvas JSON')
    await adapter.runTurn({ ...params('CONTRACT'), messages: [
      { role: 'user', content: 'Original request.' }, { role: 'user', content: 'Try again.' },
    ] }, {})
    expect(mocks.codexRunTurn).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: expect.stringContaining('Original request.') }))
  })

  it('reports an empty initial answer but permits an empty tool-acknowledgement turn', async () => {
    const adapter = new CodexAdapter(() => '/project', () => 'codex')
    mocks.codexRunTurn.mockResolvedValueOnce('{"reply":"","operations":[]}')
    await expect(adapter.runTurn(params('CONTRACT'), {})).rejects.toThrow('no answer or canvas operations')
    mocks.codexRunTurn.mockResolvedValueOnce('{"reply":"","operations":[]}')
    const acknowledgement = await adapter.runTurn({ ...params('CONTRACT'), messages: [
      { role: 'tool', toolCallId: 'applied', content: '{"ok":true}' },
    ] }, {})
    expect(acknowledgement.toolCalls).toEqual([])
  })

  it('switches Claude models while resuming the latest session and retaining the shared prompt', async () => {
    let model = 'opus'
    const adapter = new ClaudeAdapter(() => '/project', () => 'claude', 'saved-session', () => model)
    await adapter.runTurn(params('SHARED CONTRACT'), {})
    expect(mocks.claudeOptions).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'opus', initialSessionId: 'saved-session' }))
    model = 'sonnet'
    await adapter.runTurn({ ...params('SHARED CONTRACT'), messages: [{ role: 'user', content: 'First' }, { role: 'user', content: 'Next' }] }, {})
    expect(mocks.claudeOptions).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'sonnet', initialSessionId: 'claude-session' }))
    model = ''
    await adapter.runTurn(params('SHARED CONTRACT'), {})
    expect(mocks.claudeOptions).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'default', initialSessionId: 'claude-session' }))
    expect(mocks.writeClaudeGuide).toHaveBeenCalledTimes(1)
  })

  it('forwards the selected Codex model on every phase', async () => {
    let model = 'first-model'
    const adapter = new CodexAdapter(() => '/project', () => 'codex', null, () => model)
    await adapter.runTurn(params('SHARED CONTRACT'), {})
    expect(mocks.codexRunTurn).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'first-model' }))
    model = 'second-model'
    await adapter.runTurn({ ...params('SHARED CONTRACT'), phase: 'review' }, {})
    expect(mocks.codexRunTurn).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'second-model' }))
  })

  it('writes the same caller-owned semantic contract for Claude and Codex', async () => {
    const system = 'ROOT DIAGRAM CONTRACT'
    const claude = new ClaudeAdapter(() => 'D:\\project', () => 'claude')
    const codex = new CodexAdapter(() => 'D:\\project', () => 'codex')

    await claude.runTurn(params(system), {})
    await codex.runTurn(params(system), {})

    expect(mocks.writeClaudeGuide).toHaveBeenCalledWith('D:\\project', system)
    expect(mocks.writeCodexGuide).toHaveBeenCalledWith('D:\\project', system)
  })

  it('refreshes a project guide when the caller changes the semantic contract', async () => {
    const adapter = new ClaudeAdapter(() => 'D:\\project', () => 'claude')

    await adapter.runTurn(params('FIRST CONTRACT'), {})
    await adapter.runTurn({
      ...params('SECOND CONTRACT'),
      messages: [
        { role: 'user', content: 'Draw it.' },
        { role: 'user', content: 'Draw it differently.' },
      ],
    }, {})

    expect(mocks.writeClaudeGuide.mock.calls).toEqual([
      ['D:\\project', 'FIRST CONTRACT'],
      ['D:\\project', 'SECOND CONTRACT'],
    ])
  })
})
