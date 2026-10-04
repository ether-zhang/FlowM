import { HarnessClient } from './client'
import { selectedHarnessModel } from './models'
import type { HarnessConnection, HarnessModelCatalog, HarnessProfile } from './types'

const PROFILE_STORAGE = 'flowm.harnessProfile'
const MODEL_STORAGE = 'flowm.harnessModels'
const CONNECTION_STORAGE = 'flowm.activeModelConnection'
type Preferences = Pick<Storage, 'getItem' | 'setItem'>

export interface ConnectionSnapshot {
  profiles: HarnessProfile[]
  profile: HarnessProfile | null
  catalog: HarnessModelCatalog | null
  connection: HarnessConnection | null
  model: string
  loading: boolean
  error: string | null
  catalogError: string | null
  loginAttempt: string | null
  loginPending: boolean
}

export function activeModelConnection(profiles: HarnessProfile[], preferredId: string, connectedId: string | null | undefined): HarnessProfile | null {
  if (connectedId === null) return null
  if (connectedId !== undefined) return profiles.find((profile) => profile.id === connectedId && profile.signedIn) ?? null
  return profiles.find((profile) => profile.id === preferredId && profile.signedIn)
    ?? profiles.find((profile) => profile.signedIn && profile.authKind !== 'none') ?? null
}

export function createHarnessProfile(kind: HarnessProfile['kind']): HarnessProfile {
  return { id: crypto.randomUUID(), name: kind === 'openai' ? 'OpenAI' : 'Gateway', kind,
    baseUrl: kind === 'openai' ? 'https://api.openai.com/v1' : '', model: '',
    authKind: kind === 'openai' ? 'chatgpt' : 'bearer', credentialVersion: 0, account: null, subject: null, clientId: null }
}

/** One owner for account state, live discovery, model selection and runtime invalidation.
 * Only preferences are persisted. No catalog or OAuth credential crosses this store. */
export class HarnessConnections {
  private state: ConnectionSnapshot = { profiles: [], profile: null, catalog: null, connection: null,
    model: '', loading: true, error: null, catalogError: null, loginAttempt: null, loginPending: false }
  private readonly listeners = new Set<() => void>()
  private unsubscribe: (() => void) | null = null
  private running = false
  private revision = 0
  private loginRevision = 0
  private loginProfile: string | null = null
  private readonly settledLogins = new Set<string>()
  private readonly client: HarnessClient
  private readonly preferences: Preferences

  constructor(client: HarnessClient, preferences: Preferences) { this.client = client; this.preferences = preferences }
  getSnapshot = (): ConnectionSnapshot => this.state
  getConnection = (): HarnessConnection | null => this.state.connection
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(change: Partial<ConnectionSnapshot>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }
  private activate(id: string | null): void {
    this.preferences.setItem(CONNECTION_STORAGE, id ?? '')
    if (id) this.preferences.setItem(PROFILE_STORAGE, id)
  }
  private savedModels(): Record<string, string> {
    try {
      const value: unknown = JSON.parse(this.preferences.getItem(MODEL_STORAGE) ?? '{}')
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    } catch { return {} }
  }
  private selectedProfile(profiles: HarnessProfile[]): HarnessProfile | null {
    const value = this.preferences.getItem(CONNECTION_STORAGE)
    const profile = activeModelConnection(profiles, this.preferences.getItem(PROFILE_STORAGE) ?? '', value === null ? undefined : value || null)
    if (value === null) this.activate(profile?.id ?? null)
    return profile
  }
  private publishCatalog(profile: HarnessProfile, catalog: HarnessModelCatalog, preferred: string): void {
    if (catalog.profileId !== profile.id || catalog.credentialVersion !== profile.credentialVersion) {
      throw new Error('Model catalog belongs to different credentials; refresh the connection')
    }
    const model = selectedHarnessModel(catalog, preferred)
    this.update({ profile, catalog, model, connection: model ? {
      profileId: profile.id, credentialVersion: profile.credentialVersion, model,
    } : null, catalogError: model ? null : 'This connection returned no models', loading: false })
  }
  start(): void {
    if (this.running) return
    this.running = true
    this.unsubscribe = this.client.subscribe((event) => {
      if (event.method === 'runtime/disconnected') {
        ++this.revision
        ++this.loginRevision
        this.loginProfile = null
        this.update({ catalog: null, connection: null, model: '', loading: false, loginPending: false,
          loginAttempt: null, catalogError: 'Model runtime disconnected. Refresh to reconnect.' })
      } else if (event.method === 'runtime/ready') {
        // The first initialize occurs inside refresh; subsequent restarts re-read accounts too.
        if (!this.state.loading) void this.refresh()
      } else if (event.method === 'auth/changed' && event.params.profileId === this.loginProfile
        && (!this.state.loginAttempt || event.params.attemptId === this.state.loginAttempt)) {
        if (typeof event.params.attemptId === 'string') {
          this.settledLogins.add(event.params.attemptId)
          if (this.settledLogins.size > 64) this.settledLogins.delete(this.settledLogins.values().next().value!)
        }
        ++this.loginRevision
        this.loginProfile = null
        this.update({ loginAttempt: null, loginPending: false })
        if (event.params.success) this.activate(String(event.params.profileId))
        const loginRevision = this.loginRevision
        void this.refresh().then(() => {
          if (!event.params.success && loginRevision === this.loginRevision) this.update({ error: String(event.params.error ?? 'Sign-in did not complete') })
        })
      }
    })
    const revision = ++this.revision
    queueMicrotask(() => { if (this.running && revision === this.revision) void this.refresh() })
  }
  stop(): void {
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
    ++this.revision
    this.update({ catalog: null, connection: null, model: '' })
  }
  refresh = async (): Promise<void> => {
    const revision = ++this.revision
    this.update({ loading: true, connection: null, catalog: null, model: '', error: null, catalogError: null })
    let profile: HarnessProfile | null = null
    try {
      const profiles = await this.client.profiles()
      if (revision !== this.revision) return
      profile = this.selectedProfile(profiles)
      this.update({ profiles, profile })
      if (!profile) { this.update({ loading: false }); return }
      const catalog = await this.client.models(profile.id)
      if (revision !== this.revision) return
      this.publishCatalog(profile, catalog, this.savedModels()[`${profile.id}:${profile.credentialVersion}`] || profile.model)
    } catch (error) {
      if (revision !== this.revision) return
      const message = error instanceof Error ? error.message : String(error)
      this.update({ loading: false, ...(profile ? { catalogError: message } : { profile: null, error: message }) })
    }
  }
  selectModel = (model: string): void => {
    const { profile, catalog, loading } = this.state
    if (loading || !profile || !catalog || !catalog.models.some((item) => item.id === model)) {
      throw new Error('Select a model from the current connection catalog')
    }
    this.preferences.setItem(MODEL_STORAGE, JSON.stringify({ ...this.savedModels(), [`${profile.id}:${profile.credentialVersion}`]: model }))
    this.publishCatalog(profile, catalog, model)
  }
  save = async (profile: HarnessProfile, token?: string): Promise<HarnessProfile> => {
    const saved = await this.client.saveProfile(profile, token)
    this.preferences.setItem(PROFILE_STORAGE, saved.id)
    await this.refresh()
    if (this.state.error) throw new Error(this.state.error)
    return saved
  }
  connect = async (id: string): Promise<void> => {
    await this.refresh()
    if (this.state.error) throw new Error(this.state.error)
    const profile = this.state.profiles.find((profile) => profile.id === id && profile.signedIn)
    if (!profile) throw new Error('The connection needs valid credentials before it can be used')
    if (this.state.profile && this.state.profile.id !== id) throw new Error('Sign out of the active connection first')
    const revision = ++this.revision
    this.update({ loading: true, error: null, catalogError: null })
    try {
      const catalog = await this.client.models(id)
      if (revision !== this.revision) throw new Error('Connection changed while discovering models')
      this.publishCatalog(profile, catalog, this.savedModels()[`${profile.id}:${profile.credentialVersion}`] || profile.model)
      if (!this.state.connection) throw new Error(this.state.catalogError || 'This connection returned no models')
      this.activate(id)
    } catch (error) {
      if (revision === this.revision) this.update({ loading: false, profile: null, connection: null, catalog: null, model: '',
        error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  login = async (id: string): Promise<void> => {
    if (this.state.profile || this.state.loginPending) throw new Error('Sign out of the active connection first')
    const revision = ++this.loginRevision
    this.loginProfile = id
    this.update({ loginPending: true, loginAttempt: null, error: null })
    try {
      const result = await this.client.login(id)
      if (revision === this.loginRevision && this.loginProfile === id) this.update({ loginAttempt: result.attemptId })
      else if (!this.settledLogins.has(result.attemptId)) await this.client.cancelLogin(result.attemptId)
    } catch (error) {
      if (revision === this.loginRevision) { this.loginProfile = null; this.update({ loginPending: false, loginAttempt: null }) }
      throw error
    }
  }
  cancelLogin = async (): Promise<void> => {
    const attempt = this.state.loginAttempt
    ++this.loginRevision
    this.loginProfile = null
    this.update({ loginPending: false, loginAttempt: null })
    if (attempt) await this.client.cancelLogin(attempt)
  }
  logout = async (id: string): Promise<void> => {
    ++this.revision
    this.update({ connection: null, catalog: null, model: '' })
    await this.cancelLogin()
    await this.client.logout(id)
    this.activate(null)
    this.update({ profile: null })
    await this.refresh()
  }
}
