import { describe, expect, it, vi } from 'vitest'
import { HarnessConversations } from './conversations'
import { HarnessClient } from './client'
import type { HarnessNotification, HarnessSessionEvent, HarnessSessionMeta } from './types'

const meta: HarnessSessionMeta = { id: 'stable', name: 'Conversation', projectRoot: '/project', createdAt: 1 }
const row = (sequence: number, kind: string, data: Record<string, unknown> = {}, turnId: string | null = 'u'): HarnessSessionEvent => ({ sequence, id: `e${sequence}`, kind, data, turnId, timestamp: sequence })
function fixture() {
  let listener!: (notification: HarnessNotification) => void
  const emit = (event: HarnessSessionEvent) => listener({ method: 'session/event', params: { sessionId: meta.id, projectRoot: meta.projectRoot, event } })
  let sequence = 0
  const api = {
    subscribe: vi.fn((callback) => { listener = callback; return () => {} }),
    readSession: vi.fn().mockResolvedValue({ meta, events: [], hasMore: false, nextSequence: 0, activeTurnId: null }),
    beginSession: vi.fn(async (_root, _session, turnId, role, text) => emit(row(++sequence, 'turn_begin', { role, text }, turnId))),
    recordSession: vi.fn(async (_root, _session, turnId, event) => { const entry = row(++sequence, 'view', { event }, turnId); emit(entry); return entry }),
    finishSession: vi.fn(async (_root, _session, turnId, status) => emit(row(++sequence, 'turn_end', { status }, turnId))),
  }
  const service = new HarnessConversations(api as unknown as HarnessClient)
  service.start()
  return { api, service, emit }
}

describe('durable conversation coordination', () => {
  it('accepts the user request before executing and freezes one connection for the workflow', async () => {
    const { service, api } = fixture()
    await service.select(meta.projectRoot, meta.id)
    const connection = { profileId: 'gpt', credentialVersion: 3, model: 'model-a' }
    await service.run('Draw', 'canvas', connection, async (callbacks) => {
      expect(api.beginSession).toHaveBeenCalledOnce()
      expect(service.getExecution()).toMatchObject({ ...connection, flowSessionId: meta.id, role: 'canvas' })
      connection.model = 'model-b'
      expect(service.getExecution().model).toBe('model-a')
      callbacks.onText('Final answer')
    }, async () => {})
    expect(api.recordSession).toHaveBeenCalledWith(meta.projectRoot, meta.id, expect.any(String), { kind: 'text', text: 'Final answer' })
    expect(service.getSnapshot().activeTurnId).toBeNull()
    expect(() => service.getExecution()).toThrow('no active user request')
  })

  it('records framework projections once and leaves native model events to the native journal', async () => {
    const { service, api } = fixture()
    await service.select(meta.projectRoot, meta.id)
    await service.run('Work', 'project', { profileId: 'p', credentialVersion: 1, model: 'm' }, async (callbacks) => {
      callbacks.onText('Native text', 'model')
      callbacks.onActivity?.({ type: 'warning', id: 'native', text: 'Warning' }, 'model')
      callbacks.onActivity?.({ type: 'status', status: 'working' })
      callbacks.onActivity?.({ type: 'tool', id: 'canvas-op', name: 'Canvas update', status: 'completed' })
    }, async () => {})
    expect(api.recordSession).toHaveBeenCalledTimes(1)
    expect(api.recordSession.mock.calls[0][3].activity.id).toBe('canvas-op')
  })

  it('waits for durable projection writes before ending a workflow', async () => {
    const { service, api } = fixture()
    await service.select(meta.projectRoot, meta.id)
    let stored!: () => void
    api.recordSession.mockImplementationOnce(() => new Promise((resolve) => { stored = () => resolve(row(2, 'view')) }))
    const run = service.run('Draw', 'canvas', { profileId: 'p', credentialVersion: 1, model: 'm' }, async (callbacks) => { callbacks.onText('Done') }, async () => {})
    await vi.waitFor(() => expect(api.recordSession).toHaveBeenCalledOnce())
    expect(api.finishSession).not.toHaveBeenCalled()
    stored()
    await run
    expect(api.finishSession).toHaveBeenLastCalledWith(meta.projectRoot, meta.id, expect.any(String), 'completed')
  })

  it('preserves events arriving while a restore snapshot is in flight', async () => {
    const { service, api, emit } = fixture()
    let read!: (value: unknown) => void
    api.readSession.mockImplementationOnce(() => new Promise((resolve) => { read = resolve }))
    const select = service.select(meta.projectRoot, meta.id)
    emit(row(2, 'turn_end', { status: 'completed' }))
    read({ meta, events: [row(1, 'turn_begin', { text: 'Work', role: 'project' })], nextSequence: 1, hasMore: false, activeTurnId: 'u' })
    await select
    expect(service.getSnapshot().events.map((event) => event.sequence)).toEqual([1, 2])
    expect(service.getSnapshot().activeTurnId).toBeNull()
  })

  it('does not execute a task whose input could not be persisted', async () => {
    const { service, api } = fixture()
    await service.select(meta.projectRoot, meta.id)
    api.beginSession.mockRejectedValueOnce(new Error('Disk unavailable'))
    const execute = vi.fn()
    await expect(service.run('Edit', 'project', { profileId: 'p', credentialVersion: 1, model: 'm' }, execute, async () => {})).rejects.toThrow('Disk unavailable')
    expect(execute).not.toHaveBeenCalled()
    expect(api.finishSession).not.toHaveBeenCalled()
  })
})
