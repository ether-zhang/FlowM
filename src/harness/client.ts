import type { AgentQuestionAnswer } from '../agent'
import type { HarnessModelCatalog, HarnessSessionMeta, HarnessSessionPage, HarnessConversationExport, HarnessSessionEvent } from './types'
import { parseModelCatalog } from './models'
import { startHarness } from './process'
import { HARNESS_PROTOCOL, type HarnessBinding, type HarnessEvent, type HarnessNotification, type HarnessProfile, type HarnessTransport, type HarnessTransportFactory, type TurnReceipt } from './types'

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class HarnessDisconnectedError extends Error {
  constructor() { super('FlowM harness disconnected. The last request was not replayed; check its status before continuing.') }
}

/** A preparation failure happened before turn/start could be sent. */
export class HarnessNotSubmittedError extends Error {
  constructor(error: unknown) { super(error instanceof Error ? error.message : String(error), { cause: error }) }
}

/** One multiplexed connection, with request and thread routing instead of a global active turn. */
export class HarnessClient {
  private process: HarnessTransport | null = null
  private starting: Promise<void> | null = null
  private generation = 0
  private nextId = 1
  private pending = new Map<number, Pending>()
  private turns = new Map<string, { threadId: string; onEvent(event: HarnessEvent): void }>()
  private listeners = new Set<(notification: HarnessNotification) => void>()

  private readonly factory: HarnessTransportFactory
  constructor(factory: HarnessTransportFactory = startHarness) { this.factory = factory }

  subscribe(listener: (notification: HarnessNotification) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private async ready(): Promise<void> {
    if (this.starting) return this.starting
    if (this.process) return
    const generation = ++this.generation
    this.starting = (async () => {
      const process = await this.factory((event) => {
        if (generation !== this.generation) return
        if (event.kind === 'exit') this.disconnected()
        else if (event.kind === 'stdout' && event.line) this.receive(event.line)
        // Native stderr is not a model/activity channel. It may contain provider internals.
      })
      if (generation !== this.generation) { await process.stop(); throw new HarnessDisconnectedError() }
      this.process = process
      const result = await this.raw<{ protocolVersion: string }>('initialize', { protocolVersion: HARNESS_PROTOCOL }, 60_000)
      if (result.protocolVersion !== HARNESS_PROTOCOL) throw new Error('FlowM harness protocol version does not match this application')
      // A restarted native process invalidates UI directory snapshots as well as turn state.
      for (const listener of this.listeners) listener({ method: 'runtime/ready', params: { generation } })
    })().catch(async (error) => {
      const process = this.process
      this.disconnected()
      await process?.stop().catch(() => {})
      throw error
    }).finally(() => { this.starting = null })
    return this.starting
  }

  private disconnected(stopProcess = false): void {
    const process = this.process
    ++this.generation
    this.process = null
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new HarnessDisconnectedError()) }
    this.pending.clear()
    this.turns.clear()
    for (const listener of this.listeners) listener({ method: 'runtime/disconnected', params: { generation: this.generation } })
    if (stopProcess) void process?.stop().catch(() => {})
  }

  private receive(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown> }
    try { message = JSON.parse(line) } catch { this.disconnected(true); return }
    if (message.id != null) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message || 'Harness request failed'))
      else pending.resolve(message.result)
      return
    }
    if (!message.method || !message.params) return
    if (message.method === 'turn/event') {
      const { requestId, threadId, event } = message.params
      const turn = this.turns.get(String(requestId))
      if (turn && turn.threadId === threadId) turn.onEvent(event as HarnessEvent)
    } else {
      for (const listener of this.listeners) listener({ method: message.method, params: message.params })
    }
  }

  async request<T>(method: string, params: unknown = {}, timeoutMs = 60_000): Promise<T> {
    await this.ready()
    return this.raw<T>(method, params, timeoutMs)
  }

  private raw<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const process = this.process
    if (!process) return Promise.reject(new HarnessDisconnectedError())
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Harness ${method} timed out. Its input may already have been received; it was not replayed.`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject, timer })
      void process.write({ jsonrpc: '2.0', id, method, params }).catch(() => {
        const pending = this.pending.get(id)
        if (pending) { this.pending.delete(id); clearTimeout(timer); pending.reject(new HarnessDisconnectedError()) }
      })
    })
  }

  profiles(): Promise<HarnessProfile[]> { return this.request('profiles/list') }
  saveProfile(profile: HarnessProfile, token?: string): Promise<HarnessProfile> {
    const saved = { ...profile }
    delete saved.signedIn
    return this.request('profiles/save', { profile: saved, ...(token ? { token } : {}) })
  }
  async models(profileId: string): Promise<HarnessModelCatalog> { return parseModelCatalog(await this.request('models/list', { profileId })) }
  login(profileId: string): Promise<{ attemptId: string }> { return this.request('auth/start', { profileId }) }
  cancelLogin(attemptId: string): Promise<void> { return this.request('auth/cancel', { attemptId }) }
  logout(profileId: string): Promise<void> { return this.request('auth/logout', { profileId }) }
  openThread(binding: HarnessBinding): Promise<{ threadId: string }> { return this.request('thread/open', binding) }
  closeThread(threadId: string): Promise<void> { return this.request('thread/close', { threadId }) }
  cancel(threadId: string): Promise<void> { return this.request('turn/cancel', { threadId }, 20_000) }
  answer(threadId: string, answer: AgentQuestionAnswer): Promise<void> { return this.request('interaction/answer', { threadId, ...answer }) }
  status(requestId: string): Promise<TurnReceipt> { return this.request('turn/status', { requestId }) }

  sessions(projectRoot: string): Promise<HarnessSessionMeta[]> { return this.request('session/list', { projectRoot }) }
  createSession(projectRoot: string, name: string): Promise<HarnessSessionMeta> { return this.request('session/create', { projectRoot, name }) }
  readSession(projectRoot: string, sessionId: string, afterSequence = 0): Promise<HarnessSessionPage> { return this.request('session/read', { projectRoot, sessionId, afterSequence }) }
  renameSession(projectRoot: string, sessionId: string, name: string): Promise<void> { return this.request('session/rename', { projectRoot, sessionId, name }) }
  deleteSession(projectRoot: string, sessionId: string): Promise<void> { return this.request('session/delete', { projectRoot, sessionId }) }
  cancelSession(projectRoot: string, sessionId: string): Promise<void> { return this.request('session/cancel', { projectRoot, sessionId }, 25_000) }
  importSession(projectRoot: string, name: string, display: unknown[], context: unknown[], metadata: unknown, sessionId?: string): Promise<HarnessSessionMeta> {
    return this.request('session/import', { projectRoot, sessionId, name, display, context, metadata })
  }
  async exportSession(projectRoot: string, sessionId: string): Promise<HarnessConversationExport> {
    const events: HarnessSessionEvent[] = []
    let afterSequence = 0
    let revision: number | undefined
    let meta: HarnessSessionMeta
    let more: boolean
    do {
      const page = await this.request<HarnessSessionPage & { revision: number }>('session/export', { projectRoot, sessionId, afterSequence, revision })
      meta = page.meta; revision = page.revision
      for (const event of page.events) {
        if (event.kind === 'model_input') {
          const images = await Promise.all((event.data.images as string[]).map((hash) => this.request<string>('session/image', { projectRoot, sessionId, hash })))
          events.push({ ...event, data: { ...event.data, images } })
        } else events.push(event)
      }
      more = page.hasMore
      if (more && page.nextSequence <= afterSequence) throw new Error('Conversation export did not advance')
      afterSequence = page.nextSequence
    } while (more)
    return { version: 1, meta, events }
  }
  async importConversation(projectRoot: string, name: string, document: HarnessConversationExport): Promise<HarnessSessionMeta> {
    if (document.version !== 1 || !Array.isArray(document.events)) throw new Error('Unsupported conversation export')
    const meta = await this.request<HarnessSessionMeta>('session/import-begin', { projectRoot, name })
    // Separate bounded frames keep long conversations and image attachments out of the RPC limit.
    for (const event of document.events) {
      await this.request('session/import-events', { projectRoot, sessionId: meta.id, events: [event] })
    }
    await this.request('session/import-commit', { projectRoot, sessionId: meta.id })
    return meta
  }
  beginSession(projectRoot: string, sessionId: string, turnId: string, role: HarnessBinding['role'], text: string, replyTo?: string): Promise<void> { return this.request('session/begin', { projectRoot, sessionId, turnId, role, text, replyTo }) }
  finishSession(projectRoot: string, sessionId: string, turnId: string, status: 'completed' | 'failed', error?: string): Promise<void> { return this.request('session/finish', { projectRoot, sessionId, turnId, status, error }) }
  recordSession(projectRoot: string, sessionId: string, turnId: string, event: HarnessEvent | { kind: 'debug'; text: string } | { kind: 'context'; value: unknown }): Promise<HarnessSessionEvent> {
    return this.request('session/record', { projectRoot, sessionId, turnId, eventId: crypto.randomUUID(), event })
  }

  async runTurn(threadId: string, requestId: string, prompt: string, images: string[], outputSchema: unknown, onEvent: (event: HarnessEvent) => void, userTurnId?: string): Promise<TurnReceipt> {
    try { await this.ready() } catch (error) { throw new HarnessNotSubmittedError(error) }
    if (this.turns.has(requestId)) throw new Error('This request is already in flight')
    this.turns.set(requestId, { threadId, onEvent })
    try {
      const result = await this.raw<TurnReceipt>('turn/start', { threadId, requestId, prompt, images, outputSchema: outputSchema ?? null, ...(userTurnId ? { userTurnId } : {}) }, 31 * 60_000)
      if (result.status !== 'completed' || typeof result.text !== 'string') throw new Error(result.error || 'Harness did not return a completed model response')
      return result
    } finally { this.turns.delete(requestId) }
  }

  async dispose(): Promise<void> {
    const process = this.process
    this.disconnected()
    await process?.stop()
  }
}

export const harnessClient = new HarnessClient()
