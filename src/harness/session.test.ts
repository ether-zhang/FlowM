import { describe, expect, it, vi } from 'vitest'
import { HarnessClient, HarnessNotSubmittedError } from './client'
import { HarnessSession } from './session'
import type { HarnessBinding, HarnessEvent } from './types'

const binding: HarnessBinding = { projectRoot: '/p', flowSessionId: 's', profileId: 'p', credentialVersion: 1, model: 'm', role: 'project', system: '' }

describe('harness delivery lifecycle', () => {
  it('does not submit after disposal while the native thread is opening', async () => {
    let opened!: (value: { threadId: string }) => void
    const api = { openThread: vi.fn(() => new Promise((resolve) => { opened = resolve })), runTurn: vi.fn(), closeThread: vi.fn(async () => {}), status: vi.fn() }
    const session = new HarnessSession(binding, api as unknown as HarnessClient)
    const turn = session.run('change code', [], null, () => {})
    const rejected = expect(turn).rejects.toThrow('cancelled before model submission')
    const closed = session.dispose()
    opened({ threadId: 't' })
    await rejected; await closed; await session.dispose()
    expect(api.runTurn).not.toHaveBeenCalled()
    expect(api.status).not.toHaveBeenCalled()
    expect(api.closeThread).toHaveBeenCalledTimes(1)
  })
  it('keeps a preparation failure retryable without creating an uncertain receipt', async () => {
    const api = { openThread: vi.fn().mockRejectedValueOnce(new Error('Directory unavailable')).mockResolvedValue({ threadId: 't' }),
      runTurn: vi.fn().mockResolvedValue({ status: 'completed', text: 'done' }), status: vi.fn().mockRejectedValue(new Error('also offline')) }
    const session = new HarnessSession(binding, api as unknown as HarnessClient)
    await expect(session.run('change code', [], null, () => {})).rejects.toThrow('Directory unavailable')
    expect((await session.run('change code', [], null, () => {})).text).toBe('done')
    expect(api.status).not.toHaveBeenCalled()
  })
  it('does not classify a transport startup failure as submitted input', async () => {
    const api = { openThread: vi.fn().mockResolvedValue({ threadId: 't' }),
      runTurn: vi.fn().mockRejectedValueOnce(new HarnessNotSubmittedError(new Error('initialize failed'))).mockResolvedValue({ text: 'done', status: 'completed' }), status: vi.fn() }
    const session = new HarnessSession(binding, api as unknown as HarnessClient)
    await expect(session.run('change code', [], null, () => {})).rejects.toThrow('initialize failed')
    await session.run('change code', [], null, () => {})
    expect(api.status).not.toHaveBeenCalled()
  })
  it('routes streamed and final output once and ends activity from the confirmed receipt', async () => {
    const api = { openThread: vi.fn().mockResolvedValue({ threadId: 't' }), runTurn: vi.fn(async (_thread, _request, _prompt, _images, _schema, onEvent: (event: HarnessEvent) => void) => {
      onEvent({ kind: 'text', text: 'Hello ' })
      return { status: 'completed', text: 'Hello world' }
    }), status: vi.fn() }
    const onText = vi.fn(), onActivity = vi.fn()
    const session = new HarnessSession(binding, api as unknown as HarnessClient)
    await session.send({ prompt: 'talk' }, { onText, onActivity })
    expect(onText.mock.calls.map(([text]) => text).join('')).toBe('Hello world')
    expect(onText.mock.calls.every(([, source]) => source === 'model')).toBe(true)
    expect(onActivity).toHaveBeenLastCalledWith({ type: 'status', status: 'completed' }, 'model')
  })
  it('finalizes failed activity and retains the no-replay recovery behavior', async () => {
    const api = { openThread: vi.fn().mockResolvedValue({ threadId: 't' }), runTurn: vi.fn().mockRejectedValue(new Error('broken pipe')), status: vi.fn().mockResolvedValue({ status: 'uncertain' }) }
    const session = new HarnessSession(binding, api as unknown as HarnessClient)
    const onActivity = vi.fn()
    await expect(session.send({ prompt: 'change code' }, { onActivity })).rejects.toThrow('broken pipe')
    expect(onActivity).toHaveBeenLastCalledWith({ type: 'status', status: 'failed' }, 'model')
    await expect(session.send({ prompt: 'retry' }, {})).rejects.toThrow('did not settle')
    expect(api.runTurn).toHaveBeenCalledTimes(1)
  })

  it('does not return a completed model result to a host workflow interrupted by restart', async () => {
    const api = { openThread: vi.fn().mockResolvedValue({ threadId: 't' }), runTurn: vi.fn().mockRejectedValue(new Error('runtime stopped')),
      status: vi.fn().mockResolvedValue({ status: 'completed', text: '{"operations":[{"op":"create_geo"}]}' }),
      readSession: vi.fn().mockResolvedValue({ activeTurnId: null }) }
    const session = new HarnessSession({ ...binding, userTurnId: 'host-request' }, api as unknown as HarnessClient)
    await expect(session.run('Draw', [], null, () => {})).rejects.toThrow('runtime stopped')
    expect(api.readSession).toHaveBeenCalledWith(binding.projectRoot, binding.flowSessionId)
    expect(api.runTurn).toHaveBeenCalledTimes(1)
  })
})
