import { describe, expect, it, vi } from 'vitest'
import { runtimePolicy } from './execution'
import { HarnessTurn } from './turn'
import type { HarnessSession } from './session'

describe('engine-directed harness stages', () => {
  it('bounds inspection and excludes project tools from every canvas output phase', () => {
    expect(runtimePolicy('inspect')).toEqual({ phase: 'inspect', tools: 'inspect', timeoutSecs: 600 })
    for (const phase of ['build', 'review', 'finalize'] as const) expect(runtimePolicy(phase)).toEqual({ phase, tools: 'none', timeoutSecs: 600 })
    expect(runtimePolicy('project').tools).toBe('workspace')
  })
  it('inspects once per user request and leaves all later output stages without tools', async () => {
    let userTurnId = 'first'
    const run = vi.fn().mockResolvedValue({ status: 'completed', text: 'facts' })
    const turn = new HarnessTurn((system) => ({ projectRoot: '/p', flowSessionId: 's', profileId: 'p', credentialVersion: 1,
      role: 'canvas', model: 'm', system, userTurnId }), () => ({ run }) as unknown as HarnessSession)
    const input = { phase: 'build' as const, system: 'Canvas contract', messages: [{ role: 'user' as const, content: 'Draw code' }], outputSchema: {} }
    await turn.run(input, {})
    await turn.run({ ...input, phase: 'review' }, {})
    expect(run.mock.calls.map((call) => call[4].phase)).toEqual(['inspect', 'build', 'review'])
    userTurnId = 'second'
    await turn.run(input, {})
    expect(run.mock.calls.map((call) => call[4].phase)).toEqual(['inspect', 'build', 'review', 'inspect', 'build'])
  })
  it('does not start output after cancellation while inspecting', async () => {
    let finish!: () => void
    const run = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ status: 'completed', text: 'facts' }) }))
    const cancel = vi.fn(async () => {})
    const turn = new HarnessTurn({ projectRoot: '/p', flowSessionId: 's', profileId: 'p', credentialVersion: 1, role: 'canvas', model: 'm' }, () => ({ run, cancel }) as unknown as HarnessSession)
    const work = turn.run({ phase: 'build', system: 'Canvas contract', messages: [{ role: 'user', content: 'Draw' }], outputSchema: {} }, {})
    await turn.cancel(); finish()
    await expect(work).rejects.toThrow('stopped before output')
    expect(run).toHaveBeenCalledOnce()
  })
})
