import { useCallback, useEffect, useState } from 'react'
import { harnessClient, type HarnessProfile } from '../harness'
import { activeModelConnection } from './modelConnectionState'

const PROFILE_STORAGE = 'flowm.harnessProfile'
const MODEL_STORAGE = 'flowm.harnessModels'
const CONNECTION_STORAGE = 'flowm.activeModelConnection'

function savedConnection(): string | null | undefined {
  const value = localStorage.getItem(CONNECTION_STORAGE)
  return value === null ? undefined : value || null
}

function savedModels(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(MODEL_STORAGE) ?? '{}') as Record<string, string> } catch { return {} }
}

export function useHarnessProfiles(enabled: boolean) {
  const [profiles, setProfiles] = useState<HarnessProfile[]>([])
  const [activeId, setActiveId] = useState(localStorage.getItem(PROFILE_STORAGE) ?? '')
  const [models, setModels] = useState(savedModels)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loginAttempt, setLoginAttempt] = useState<string | null>(null)
  const [connectedId, setConnectedId] = useState(savedConnection)

  const activate = useCallback((id: string | null) => {
    localStorage.setItem(CONNECTION_STORAGE, id ?? '')
    setConnectedId(id)
    if (id) { setActiveId(id); localStorage.setItem(PROFILE_STORAGE, id) }
  }, [])

  const refresh = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    try {
      const profiles = await harnessClient.profiles()
      setProfiles(profiles)
      if (savedConnection() === undefined) {
        activate(activeModelConnection(profiles, localStorage.getItem(PROFILE_STORAGE) ?? '', undefined)?.id ?? null)
      }
      setError(null)
      return profiles
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setLoading(false) }
  }, [enabled, activate])

  useEffect(() => {
    if (!enabled) return
    let current = true
    queueMicrotask(() => { if (current) void refresh() })
    const unsubscribe = harnessClient.subscribe((event) => {
      if (event.method !== 'auth/changed') return
      setLoginAttempt(null)
      if (event.params.success && typeof event.params.profileId === 'string') activate(event.params.profileId)
      void refresh().then(() => {
        if (!event.params.success) setError(String(event.params.error ?? 'Browser login did not complete'))
      })
    })
    return () => { current = false; unsubscribe() }
  }, [enabled, refresh, activate])

  const profile = activeModelConnection(profiles, activeId, connectedId)
  const modelKey = profile ? `${profile.id}:${profile.credentialVersion}` : ''
  const model = models[modelKey] || profile?.model || ''

  const select = (id: string) => {
    if (profile && profile.id !== id) return
    setActiveId(id)
    localStorage.setItem(PROFILE_STORAGE, id)
  }
  const selectModel = (model: string) => {
    const next = { ...models, [modelKey]: model }
    setModels(next)
    localStorage.setItem(MODEL_STORAGE, JSON.stringify(next))
  }
  const save = async (profile: HarnessProfile, token?: string) => {
    const saved = await harnessClient.saveProfile(profile, token)
    select(saved.id)
    await refresh()
    return saved
  }
  const login = async (id: string) => { const { attemptId } = await harnessClient.login(id); setLoginAttempt(attemptId) }
  const logout = async (id: string) => { await harnessClient.logout(id); activate(null); await refresh() }
  const connect = async (id: string) => {
    const available = await refresh()
    if (!available?.some((profile) => profile.id === id && profile.signedIn)) throw new Error('The connection needs valid credentials before it can be used')
    activate(id)
  }
  const cancelLogin = async () => { if (loginAttempt) await harnessClient.cancelLogin(loginAttempt); setLoginAttempt(null) }
  return { profiles, profile, model, select, selectModel, save, login, logout, connect, loginAttempt, cancelLogin, error, loading, refresh }
}
