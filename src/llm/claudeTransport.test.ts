import { describe, expect, it, vi } from 'vitest'
import { ClaudeControlUnavailableError } from '../agentControl'
import {
  CompatibleClaudeTransport,
  type ClaudeTransportFactory,
  type ClaudeTransportResult,
  type ClaudeTurnTransport,
} from './claudeTransport'

function fakeTransport(
  kind: ClaudeTurnTransport['kind'],
  runTurn: ClaudeTurnTransport['runTurn'],
): ClaudeTurnTransport {
  return {
    kind,
    sessionId: null,
    runTurn,
    answerQuestion: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  }
}

describe('CompatibleClaudeTransport', () => {
  it('falls back once when the control handshake is unavailable', async () => {
    const expected: ClaudeTransportResult = {
      structured: { reply: 'ok', operations: [] },
      prose: '',
    }
    const control = fakeTransport('control', vi.fn(async () => {
      throw new ClaudeControlUnavailableError('unsupported control protocol')
    }))
    const legacy = fakeTransport('legacy', vi.fn(async () => expected))
    const factory: ClaudeTransportFactory = {
      createControl: vi.fn(() => control),
      createLegacy: vi.fn(() => legacy),
    }
    const onActivity = vi.fn()
    const transport = new CompatibleClaudeTransport(
      { cwd: '/project', initialSessionId: 'session-1' },
      factory,
    )

    await expect(transport.runTurn('first', { onActivity })).resolves.toEqual(expected)
    await expect(transport.runTurn('second', { onActivity })).resolves.toEqual(expected)

    expect(control.runTurn).toHaveBeenCalledTimes(1)
    expect(legacy.runTurn).toHaveBeenCalledTimes(2)
    expect(factory.createLegacy).toHaveBeenCalledTimes(1)
    expect(control.dispose).toHaveBeenCalledTimes(1)
    expect(transport.kind).toBe('legacy')
    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      id: 'claude-control-fallback',
    }))
  })

  it('does not hide ordinary control runtime errors', async () => {
    const failure = new Error('Claude authentication failed')
    const control = fakeTransport('control', vi.fn(async () => {
      throw failure
    }))
    const factory: ClaudeTransportFactory = {
      createControl: vi.fn(() => control),
      createLegacy: vi.fn(() => fakeTransport('legacy', vi.fn())),
    }
    const transport = new CompatibleClaudeTransport({ cwd: '/project' }, factory)

    await expect(transport.runTurn('prompt', {})).rejects.toBe(failure)
    expect(factory.createLegacy).not.toHaveBeenCalled()
  })
})
