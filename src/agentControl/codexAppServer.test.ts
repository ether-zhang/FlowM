import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentControlProcess, type AgentControlProcessEvent } from './agentControlProcess'
import { CodexAppServerClient } from './codexAppServer'
import type { JsonRpcMessage } from './codexAppServerProtocol'

const clients: CodexAppServerClient[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function harness(stallInitialize = false) {
  let emit: (event: AgentControlProcessEvent) => void = () => {}
  const requests: JsonRpcMessage[] = []
  const notify = (method: string, params: unknown) => emit({ kind: 'stdout', line: JSON.stringify({ method, params }) })
  const process = {
    stop: vi.fn(async () => undefined),
    write: vi.fn(async (message: JsonRpcMessage) => {
      requests.push(message)
      if (message.id == null || (stallInitialize && message.method === 'initialize')) return
      const result = message.method === 'thread/start'
        ? { thread: { id: 'thread-1' }, model: 'selected-model' }
        : message.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {}
      emit({ kind: 'stdout', line: JSON.stringify({ id: message.id, result }) })
    }),
  }
  vi.spyOn(AgentControlProcess, 'startCodex').mockImplementation(async (_bin, _cwd, _readOnly, onEvent) => {
    emit = onEvent
    return { process: process as unknown as AgentControlProcess, sandboxMode: 'read-only' as const }
  })
  const client = new CodexAppServerClient({ cwd: '/project', readOnly: true })
  clients.push(client)
  return { client, notify, requests, process }
}

describe('Codex stopgap response guards', () => {
  it('sets the startup model and medium effort, then returns a normal response', async () => {
    const h = harness()
    const result = h.client.runTurn({ prompt: 'Draw.', model: 'selected-model', outputSchema: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.requests.find((request) => request.method === 'thread/start')?.params).toMatchObject({ model: 'selected-model' })
    expect(h.requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({ effort: 'medium' })
    h.notify('turn/completed', { turn: { status: 'completed', items: [
      { type: 'agentMessage', phase: 'final_answer', text: '{"reply":"Done","operations":[]}' },
    ] } })
    await expect(result).resolves.toContain('Done')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.process.stop).not.toHaveBeenCalled()
  })

  it('stops a stream that degenerates into whitespace across multiple chunks', async () => {
    const h = harness()
    const onActivity = vi.fn()
    const result = expect(h.client.runTurn({ prompt: 'Draw.', outputSchema: {}, onActivity })).rejects.toThrow('excessive whitespace')
    await vi.advanceTimersByTimeAsync(0)
    h.notify('item/started', { item: { id: 'message', type: 'agentMessage', phase: 'final_answer' } })
    h.notify('item/agentMessage/delta', { itemId: 'message', delta: '{"reply":' })
    h.notify('item/agentMessage/delta', { itemId: 'message', delta: '\t'.repeat(4096) })
    h.notify('item/agentMessage/delta', { itemId: 'message', delta: '\t'.repeat(4096) })
    await result
    expect(h.process.stop).toHaveBeenCalledOnce()
    expect(onActivity).toHaveBeenLastCalledWith({ type: 'status', status: 'failed' })
  })

  it('bounds startup RPC waits and a model turn that never completes', async () => {
    const startup = harness(true)
    const first = expect(startup.client.runTurn({ prompt: 'Draw.' })).rejects.toThrow('initialize timed out')
    await vi.advanceTimersByTimeAsync(60_000)
    await first
    expect(startup.process.stop).toHaveBeenCalledOnce()

    const running = harness()
    const second = expect(running.client.runTurn({ prompt: 'Draw.' })).rejects.toThrow('within 5 minutes')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await second
    expect(running.process.stop).toHaveBeenCalledOnce()
  })

  it('surfaces a terminal provider error even without a turn/completed event', async () => {
    const h = harness()
    const result = expect(h.client.runTurn({ prompt: 'Draw.' })).rejects.toThrow('upstream failed')
    await vi.advanceTimersByTimeAsync(0)
    h.notify('error', { error: { message: 'upstream failed' }, willRetry: false })
    await result
    expect(h.process.stop).toHaveBeenCalledOnce()
  })
})
