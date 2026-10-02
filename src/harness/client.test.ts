import { describe, expect, it, vi } from 'vitest'
import { HarnessClient } from './client'
import { HarnessSession } from './session'
import type { HarnessProcessEvent, HarnessTransportFactory } from './types'

function transport() {
  const listeners: ((event: HarnessProcessEvent) => void)[] = []
  const sent: { id: number; method: string; params: Record<string, unknown> }[] = []
  const respond = (connection: number, value: unknown) => listeners[connection]({ kind: 'stdout', line: JSON.stringify(value) })
  const factory: HarnessTransportFactory = async (listener) => {
    const connection = listeners.push(listener) - 1
    return {
      write: async (value) => {
        const request = value as (typeof sent)[number]
        sent.push(request)
        if (request.method === 'initialize') queueMicrotask(() => respond(connection, { id: request.id, result: { protocolVersion: 'flowm.harness/1' } }))
        if (request.method === 'turn/status') queueMicrotask(() => respond(connection, { id: request.id, result: { status: 'uncertain' } }))
      },
      stop: async () => {},
    }
  }
  return { client: new HarnessClient(factory), sent, listeners, respond }
}

describe('FlowM harness connection', () => {
  it('routes simultaneous turns by request AND thread and ignores cross-thread events', async () => {
    const { client, sent, respond } = transport()
    const first = vi.fn()
    const second = vi.fn()
    const a = client.runTurn('thread-a', 'request-a', 'a', [], null, first)
    const b = client.runTurn('thread-b', 'request-b', 'b', [], null, second)
    await vi.waitFor(() => expect(sent.filter((request) => request.method === 'turn/start')).toHaveLength(2))
    respond(0, { method: 'turn/event', params: { threadId: 'thread-b', requestId: 'request-a', event: { kind: 'text', text: 'forged' } } })
    respond(0, { method: 'turn/event', params: { threadId: 'thread-b', requestId: 'request-b', event: { kind: 'text', text: 'b' } } })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith({ kind: 'text', text: 'b' })
    for (const request of sent.filter((request) => request.method === 'turn/start')) respond(0, { id: request.id, result: { status: 'completed', text: request.params.prompt } })
    expect((await a).text).toBe('a')
    expect((await b).text).toBe('b')
    await client.dispose()
  })

  it('rejects disconnected turns, queries a durable receipt, and never resubmits their input', async () => {
    const { client, sent, listeners, respond } = transport()
    const callback = vi.fn()
    const run = client.runTurn('t', 'r', 'modify files', [], null, callback)
    const rejected = expect(run).rejects.toThrow('not replayed')
    await vi.waitFor(() => expect(sent.some((request) => request.method === 'turn/start')).toBe(true))
    listeners[0]({ kind: 'exit', code: 1 })
    await rejected
    expect((await client.status('r')).status).toBe('uncertain')
    respond(0, { method: 'turn/event', params: { threadId: 't', requestId: 'r', event: { kind: 'text', text: 'old process' } } })
    expect(callback).not.toHaveBeenCalled()
    expect(sent.filter((request) => request.method === 'turn/start')).toHaveLength(1)
    await client.dispose()
  })
})

describe('harness session recovery', () => {
  it('honors cancellation while a thread is still opening', async () => {
    let opened!: (value: { threadId: string }) => void
    const client = { openThread: vi.fn(() => new Promise((resolve) => { opened = resolve })), runTurn: vi.fn(), status: vi.fn().mockResolvedValue({ status: 'not-received' }) } as unknown as HarnessClient
    const session = new HarnessSession({ projectRoot: '/project', profileId: 'p', model: 'm', flowSessionId: 's', role: 'canvas', system: '' }, client)
    const run = session.run('draw', [], null, () => {})
    const rejected = expect(run).rejects.toThrow('cancelled before model submission')
    await session.cancel()
    opened({ threadId: 't' })
    await rejected
    expect(client.runTurn).not.toHaveBeenCalled()
  })
  it('blocks continuation when accepted input has an uncertain outcome', async () => {
    const client = {
      openThread: vi.fn().mockResolvedValue({ threadId: 't' }),
      runTurn: vi.fn().mockRejectedValue(new Error('broken pipe')),
      status: vi.fn().mockResolvedValue({ status: 'uncertain' }),
    } as unknown as HarnessClient
    const session = new HarnessSession({ projectRoot: '/project', profileId: 'p', model: 'm', flowSessionId: 's', role: 'project', system: '' }, client)
    await expect(session.run('modify files', [], null, () => {})).rejects.toThrow('broken pipe')
    await expect(session.run('retry', [], null, () => {})).rejects.toThrow('did not settle')
    expect(client.runTurn).toHaveBeenCalledTimes(1)
  })
  it('recovers only a confirmed completed result after a lost response', async () => {
    const client = {
      openThread: vi.fn().mockResolvedValue({ threadId: 't' }),
      runTurn: vi.fn().mockRejectedValue(new Error('broken pipe')),
      status: vi.fn().mockResolvedValue({ status: 'completed', text: 'saved result' }),
    } as unknown as HarnessClient
    const persisted = vi.fn().mockResolvedValue(undefined)
    const session = new HarnessSession({ projectRoot: '/project', profileId: 'p', model: 'm', flowSessionId: 's', role: 'canvas', system: '' }, client, persisted)
    expect((await session.run('draw', [], null, () => {})).text).toBe('saved result')
    expect(persisted).toHaveBeenCalledWith('t')
    expect(client.runTurn).toHaveBeenCalledTimes(1)
  })
})
