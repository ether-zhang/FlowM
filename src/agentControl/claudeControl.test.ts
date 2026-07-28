import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControlProcess } from './agentControlProcess'
import {
  ClaudeControlClient,
  ClaudeControlUnavailableError,
} from './claudeControl'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ClaudeControlClient initialization', () => {
  it('reports a missing control handshake as a compatibility error', async () => {
    vi.useFakeTimers()
    const process = {
      write: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }
    vi.spyOn(AgentControlProcess, 'startClaude').mockResolvedValue(
      process as unknown as AgentControlProcess,
    )
    const client = new ClaudeControlClient({ cwd: '/project' })
    const result = expect(client.runTurn({ prompt: 'hello' })).rejects.toBeInstanceOf(
      ClaudeControlUnavailableError,
    )

    await vi.runAllTimersAsync()
    await result
    expect(process.stop).toHaveBeenCalledTimes(1)
  })

  it('preserves executable startup failures', async () => {
    const failure = new Error('spawn failed')
    vi.spyOn(AgentControlProcess, 'startClaude').mockRejectedValue(failure)
    const client = new ClaudeControlClient({ cwd: '/project' })

    await expect(client.runTurn({ prompt: 'hello' })).rejects.toBe(failure)
  })
})
