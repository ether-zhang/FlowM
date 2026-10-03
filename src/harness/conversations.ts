import { HarnessClient, harnessClient } from './client'
import type { HarnessCallbacks } from './events'
import type { HarnessConnection, HarnessConversationExport, HarnessExecution, HarnessSessionEvent, HarnessSessionMeta } from './types'

export interface ConversationSnapshot {
  meta: HarnessSessionMeta | null
  events: readonly HarnessSessionEvent[]
  error: string | null
  activeTurnId: string | null
}

/** Native journals are authoritative. This service coordinates a host workflow and subscribes
 * to durable events without knowing the UI, canvas schema, or provider-specific history. */
export class HarnessConversations {
  private snapshot: ConversationSnapshot = { meta: null, events: [], error: null, activeTurnId: null }
  private readonly listeners = new Set<() => void>()
  private unsubscribe: (() => void) | null = null
  private execution: HarnessExecution | null = null
  private generation = 0
  private loading = false
  private selectionBuffer: { projectRoot: string; id: string; events: HarnessSessionEvent[] } | null = null
  private readonly client: HarnessClient
  constructor(client: HarnessClient = harnessClient) { this.client = client }
  getSnapshot = (): ConversationSnapshot => this.snapshot
  getExecution = (): HarnessExecution => {
    if (!this.execution) throw new Error('Conversation has no active user request')
    return this.execution
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(change: Partial<ConversationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change }
    for (const listener of this.listeners) listener()
  }
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.client.subscribe((notification) => {
      if (notification.method === 'session/event') {
        const event = notification.params.event as HarnessSessionEvent
        const buffer = this.selectionBuffer
        if (buffer && buffer.id === notification.params.sessionId && buffer.projectRoot === notification.params.projectRoot) {
          buffer.events.push(event)
        }
        const { meta, events } = this.snapshot
        if (!meta || meta.id !== notification.params.sessionId || meta.projectRoot !== notification.params.projectRoot) return
        if (events.some((existing) => existing.sequence === event.sequence)) return
        this.publish({ events: [...events, event].sort((a, b) => a.sequence - b.sequence),
          ...(event.kind === 'turn_begin' ? { activeTurnId: event.turnId } : event.kind === 'turn_end' ? { activeTurnId: null } : {}) })
      } else if (notification.method === 'runtime/ready' && this.snapshot.meta && !this.loading) {
        const { projectRoot, id } = this.snapshot.meta
        void this.select(projectRoot, id).catch((error) => this.publish({ error: String(error) }))
      }
    })
  }
  stop(): void { ++this.generation; this.loading = false; this.selectionBuffer = null; this.unsubscribe?.(); this.unsubscribe = null }
  async select(projectRoot: string, sessionId: string): Promise<void> {
    const generation = ++this.generation
    this.loading = true
    const buffer = { projectRoot, id: sessionId, events: [] as HarnessSessionEvent[] }
    this.selectionBuffer = buffer
    const events: HarnessSessionEvent[] = []
    let after = 0
    let meta: HarnessSessionMeta
    let activeTurnId: string | null
    let more: boolean
    try { do {
      const page = await this.client.readSession(projectRoot, sessionId, after)
      if (generation !== this.generation) return
      meta = page.meta
      buffer.projectRoot = meta.projectRoot
      activeTurnId = page.activeTurnId
      events.push(...page.events)
      more = page.hasMore
      if (more && page.nextSequence <= after) throw new Error('Conversation journal did not advance')
      after = page.nextSequence
    } while (more)
    const merged = [...new Map([...events, ...buffer.events].map((event) => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence)
    const lastState = merged.findLast((event) => event.kind === 'turn_begin' || event.kind === 'turn_end')
    if (lastState) activeTurnId = lastState.kind === 'turn_begin' ? lastState.turnId : null
    this.publish({ meta, events: merged, error: null, activeTurnId })
    } finally { if (generation === this.generation) { this.loading = false; this.selectionBuffer = null } }
  }
  list(projectRoot: string): Promise<HarnessSessionMeta[]> { return this.client.sessions(projectRoot) }
  create(projectRoot: string, name: string): Promise<HarnessSessionMeta> { return this.client.createSession(projectRoot, name) }
  rename(projectRoot: string, id: string, name: string): Promise<void> { return this.client.renameSession(projectRoot, id, name) }
  delete(projectRoot: string, id: string): Promise<void> { return this.client.deleteSession(projectRoot, id) }
  importLegacy(projectRoot: string, name: string, display: unknown[], context: unknown[], metadata: unknown, id?: string): Promise<HarnessSessionMeta> {
    return this.client.importSession(projectRoot, name, display, context, metadata, id)
  }
  importDocument(projectRoot: string, name: string, document: HarnessConversationExport): Promise<HarnessSessionMeta> { return this.client.importConversation(projectRoot, name, document) }
  exportCurrent(): Promise<HarnessConversationExport> {
    const meta = this.snapshot.meta
    if (!meta) return Promise.reject(new Error('Select a conversation first'))
    return this.client.exportSession(meta.projectRoot, meta.id)
  }
  cancel(): Promise<void> {
    const meta = this.snapshot.meta
    return meta ? this.client.cancelSession(meta.projectRoot, meta.id) : Promise.resolve()
  }
  async recordContext(value: unknown): Promise<void> {
    const run = this.getExecution()
    await this.client.recordSession(run.projectRoot, run.flowSessionId, run.userTurnId, { kind: 'context', value })
  }
  async run(text: string, role: HarnessExecution['role'], connection: HarnessConnection,
    execute: (callbacks: HarnessCallbacks & { onText(text: string, source?: 'model'): void }) => Promise<void>,
    cancel: () => Promise<void>, debug = false, replyTo?: string): Promise<void> {
    if (this.execution) throw new Error('Conversation is already busy')
    const meta = this.snapshot.meta
    if (!meta) throw new Error('Select a conversation first')
    const turnId = crypto.randomUUID()
    this.execution = { ...connection, role, projectRoot: meta.projectRoot, flowSessionId: meta.id, userTurnId: turnId }
    let begun = false
    let pending = Promise.resolve()
    let journalError: unknown = null
    const record = (event: Parameters<HarnessClient['recordSession']>[3]) => {
      pending = pending.then(async () => {
        if (journalError) return
        try { await this.client.recordSession(meta.projectRoot, meta.id, turnId, event) }
        catch (error) { journalError = error; await cancel().catch(() => {}) }
      })
    }
    try {
      await this.client.beginSession(meta.projectRoot, meta.id, turnId, role, text, replyTo)
      begun = true
      await execute({
        onText: (text, source) => { if (!source && text) record({ kind: 'text', text }) },
        onActivity: (activity, source) => { if (!source && activity.type !== 'status') record({ kind: 'activity', activity }) },
        onQuestion: (question, source) => { if (!source) record({ kind: 'question', question }) },
        onDebug: debug ? (text) => record({ kind: 'debug', text }) : undefined,
      })
      await pending
      if (journalError) throw journalError
      await this.client.finishSession(meta.projectRoot, meta.id, turnId, 'completed')
    } catch (error) {
      await pending
      if (begun) await this.client.finishSession(meta.projectRoot, meta.id, turnId, 'failed', error instanceof Error ? error.message : String(error)).catch(() => {})
      throw error
    } finally { this.execution = null }
  }
}
