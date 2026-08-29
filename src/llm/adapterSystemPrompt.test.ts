import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunTurnParams } from './adapter'

const mocks = vi.hoisted(() => ({
  writeClaudeGuide: vi.fn(async () => '.flowm/claude-canvas.md'),
  writeCodexGuide: vi.fn(async () => '.flowm/codex-canvas.md'),
  writeDesign: vi.fn(async () => '.flowm/design.png'),
  claudeRunTurn: vi.fn(async () => ({
    structured: { operations: [] },
    prose: '',
  })),
  codexRunTurn: vi.fn(async () => JSON.stringify({
    reply: '',
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
