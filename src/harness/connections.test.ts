import { describe, expect, it, vi } from 'vitest'
import { HarnessConnections } from './connections'
import { HarnessClient } from './client'
import type { HarnessModelCatalog, HarnessNotification, HarnessProfile } from './types'

const profile: HarnessProfile = { id: 'p', name: 'GPT', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'old-model',
  authKind: 'chatgpt', credentialVersion: 1, account: null, subject: null, clientId: null, signedIn: true }
const catalog = (version = 1, model = 'live'): HarnessModelCatalog => ({ profileId: 'p', credentialVersion: version,
  source: 'openai-account', models: [{ id: model, label: model, origin: 'remote' }], defaultModel: model })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const listeners = new Set<(notification: HarnessNotification) => void>()
  const storage = new Map<string, string>()
  const api = {
    subscribe: (fn: (notification: HarnessNotification) => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    profiles: vi.fn(async () => [profile]), models: vi.fn(async () => catalog()),
    saveProfile: vi.fn(async (value: HarnessProfile) => value), login: vi.fn(async () => ({ attemptId: 'attempt' })),
    cancelLogin: vi.fn(async () => {}), logout: vi.fn(async () => {}),
  }
  const service = new HarnessConnections(api as unknown as HarnessClient, {
    getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) },
  })
  const emit = (method: string, params = {}) => { for (const listener of listeners) listener({ method, params }) }
  return { api, service, storage, emit }
}

describe('harness connection ownership', () => {
  it('discovers on startup and persists only model preferences', async () => {
    const { api, service, storage } = fixture()
    service.start()
    await vi.waitFor(() => expect(service.getConnection()?.model).toBe('live'))
    expect(api.models).toHaveBeenCalledTimes(1)
    service.selectModel('live')
    expect(JSON.parse(storage.get('flowm.harnessModels')!)).toEqual({ 'p:1': 'live' })
    expect([...storage.values()].some((value) => value.includes('models'))).toBe(false)
    expect(() => service.selectModel('gpt-6.1-sol')).toThrow('current connection catalog')
    service.stop()
  })
  it('refreshes credentials and catalog together after a native restart', async () => {
    const { api, service, emit } = fixture()
    service.start()
    await vi.waitFor(() => expect(service.getConnection()?.credentialVersion).toBe(1))
    emit('runtime/disconnected')
    expect(service.getConnection()).toBeNull()
    api.profiles.mockResolvedValue([{ ...profile, credentialVersion: 2 }])
    api.models.mockResolvedValue(catalog(2, 'new-model'))
    emit('runtime/ready')
    await vi.waitFor(() => expect(service.getConnection()).toEqual({ profileId: 'p', credentialVersion: 2, model: 'new-model' }))
    expect(api.profiles).toHaveBeenCalledTimes(2)
    service.stop()
  })
  it('discards a delayed directory after logout rather than reconnecting', async () => {
    const { api, service, storage } = fixture()
    const pending = deferred<HarnessModelCatalog>()
    api.models.mockReturnValueOnce(pending.promise)
    const first = service.refresh()
    await vi.waitFor(() => expect(api.models).toHaveBeenCalledTimes(1))
    api.profiles.mockResolvedValue([{ ...profile, signedIn: false, credentialVersion: 2 }])
    await service.logout('p')
    pending.resolve(catalog())
    await first
    expect(service.getConnection()).toBeNull()
    expect(service.getSnapshot().profile).toBeNull()
    expect(storage.get('flowm.activeModelConnection')).toBe('')
  })
  it('lets only the latest refresh publish a model directory', async () => {
    const { api, service } = fixture()
    const pending = deferred<HarnessModelCatalog>()
    api.models.mockReturnValueOnce(pending.promise)
    const first = service.refresh()
    await vi.waitFor(() => expect(api.models).toHaveBeenCalledTimes(1))
    api.models.mockResolvedValue(catalog(1, 'new-model'))
    await service.refresh()
    pending.resolve(catalog(1, 'obsolete-model'))
    await first
    expect(service.getConnection()?.model).toBe('new-model')
  })
  it('clears a usable selection when live discovery fails', async () => {
    const { api, service } = fixture()
    await service.refresh()
    api.models.mockRejectedValue(new Error('Upstream discovery failed'))
    await service.refresh()
    expect(service.getSnapshot()).toMatchObject({ connection: null, catalog: null, model: '', catalogError: 'Upstream discovery failed' })
  })
  it('rejects a directory belonging to another credential version', async () => {
    const { api, service } = fixture()
    api.models.mockResolvedValue(catalog(2))
    await service.refresh()
    expect(service.getConnection()).toBeNull()
    expect(service.getSnapshot().catalogError).toContain('different credentials')
  })
  it('selects a harness kernel candidate using the same credential binding', async () => {
    const { api, service } = fixture()
    api.models.mockResolvedValue({ ...catalog(), models: [...catalog().models,
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', origin: 'kernel' }] })
    await service.refresh()
    service.selectModel('gpt-6.1-sol')
    expect(service.getConnection()).toEqual({ profileId: 'p', credentialVersion: 1, model: 'gpt-6.1-sol' })
    expect(api.models).toHaveBeenCalledTimes(1)
  })
  it('does not reconnect from stale profile data after refresh fails', async () => {
    const { api, service, storage } = fixture()
    storage.set('flowm.activeModelConnection', '')
    await service.refresh()
    api.profiles.mockRejectedValue(new Error('Profile lookup failed'))
    await expect(service.connect('p')).rejects.toThrow('Profile lookup failed')
    expect(service.getConnection()).toBeNull()
    expect(storage.get('flowm.activeModelConnection')).toBe('')
  })
  it('activates a gateway only after its own credential-bound model directory succeeds', async () => {
    const { api, service, storage } = fixture()
    const gateway = { ...profile, id: 'gateway', kind: 'gateway' as const, authKind: 'bearer' as const,
      baseUrl: 'https://openrouter.ai/api/v1', model: '' }
    storage.set('flowm.activeModelConnection', '')
    api.profiles.mockResolvedValue([gateway])
    api.models.mockResolvedValue({ ...catalog(), profileId: 'gateway', source: 'gateway',
      models: [{ id: 'anthropic/claude-fixture', label: 'Claude fixture', origin: 'remote' }], defaultModel: 'anthropic/claude-fixture' })
    await service.connect('gateway')
    expect(api.models).toHaveBeenCalledExactlyOnceWith('gateway')
    expect(storage.get('flowm.activeModelConnection')).toBe('gateway')
    expect(service.getConnection()).toEqual({ profileId: 'gateway', credentialVersion: 1, model: 'anthropic/claude-fixture' })
  })
  it('reports gateway discovery errors without persisting an active connection', async () => {
    const { api, service, storage } = fixture()
    storage.set('flowm.activeModelConnection', '')
    api.models.mockRejectedValueOnce(new Error('Model discovery returned HTTP 401'))
    await expect(service.connect('p')).rejects.toThrow('HTTP 401')
    expect(storage.get('flowm.activeModelConnection')).toBe('')
    expect(service.getSnapshot()).toMatchObject({ profile: null, connection: null, loading: false, error: 'Model discovery returned HTTP 401' })
  })
  it('does not activate a delayed gateway directory after logout', async () => {
    const { api, service, storage } = fixture()
    storage.set('flowm.activeModelConnection', '')
    const pending = deferred<HarnessModelCatalog>()
    api.models.mockReturnValueOnce(pending.promise)
    const connect = service.connect('p')
    await vi.waitFor(() => expect(api.models).toHaveBeenCalledOnce())
    api.profiles.mockResolvedValue([{ ...profile, signedIn: false, credentialVersion: 2 }])
    await service.logout('p')
    pending.resolve(catalog())
    await expect(connect).rejects.toThrow('Connection changed')
    expect(storage.get('flowm.activeModelConnection')).toBe('')
    expect(service.getConnection()).toBeNull()
  })
  it('handles completion arriving before the sign-in start response', async () => {
    const { api, service, emit, storage } = fixture()
    storage.set('flowm.activeModelConnection', '')
    api.profiles.mockResolvedValue([{ ...profile, signedIn: false }])
    service.start()
    await vi.waitFor(() => expect(service.getSnapshot().loading).toBe(false))
    api.login.mockImplementation(async () => {
      api.profiles.mockResolvedValue([profile])
      emit('auth/changed', { profileId: 'p', attemptId: 'attempt', success: true })
      return { attemptId: 'attempt' }
    })
    await service.login('p')
    await vi.waitFor(() => expect(service.getConnection()?.model).toBe('live'))
    expect(service.getSnapshot()).toMatchObject({ loginPending: false, loginAttempt: null })
    expect(api.cancelLogin).not.toHaveBeenCalled()
    service.stop()
  })
  it('cancels a late sign-in start and ignores its later callback', async () => {
    const { api, service, storage, emit } = fixture()
    storage.set('flowm.activeModelConnection', '')
    service.start()
    await vi.waitFor(() => expect(service.getSnapshot().loading).toBe(false))
    const pending = deferred<{ attemptId: string }>()
    api.login.mockReturnValue(pending.promise)
    const login = service.login('p')
    await service.cancelLogin()
    pending.resolve({ attemptId: 'late' })
    await login
    expect(api.cancelLogin).toHaveBeenCalledWith('late')
    emit('auth/changed', { profileId: 'p', attemptId: 'late', success: true })
    expect(service.getConnection()).toBeNull()
    expect(storage.get('flowm.activeModelConnection')).toBe('')
    service.stop()
  })
  it('performs one startup fetch through a StrictMode start/stop/start sequence', async () => {
    const { api, service } = fixture()
    service.start(); service.stop(); service.start()
    await vi.waitFor(() => expect(service.getConnection()?.model).toBe('live'))
    expect(api.profiles).toHaveBeenCalledTimes(1)
    service.stop()
  })
})
