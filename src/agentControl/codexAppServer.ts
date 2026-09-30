import type { AgentActivityEvent, AgentModel, AgentQuestion, AgentQuestionAnswer } from '../agent'
import { AgentControlProcess, type AgentControlProcessEvent } from './agentControlProcess'
import { cleanAgentDiagnostic } from './diagnostics'
import {
  codexCompletedTurnText,
  codexActivityForItem,
  codexCommentaryEvent,
  codexReasoningText,
  parseCodexServerRequest,
  parseCodexModelPage,
  type JsonRpcId,
  type JsonRpcMessage,
} from './codexAppServerProtocol'

// Temporary guardrails until the harness rewrite: fail visibly instead of waiting forever.
const RPC_TIMEOUT_MS = 60_000
const TURN_TIMEOUT_MS = 5 * 60_000
const MAX_OUTPUT_CHARS = 512_000
const MAX_WHITESPACE_RUN = 8_192

export interface CodexAppServerOptions {
  bin?: string
  cwd: string
  initialThreadId?: string
  readOnly: boolean
}

export interface CodexAppServerTurn {
  prompt: string
  /** Empty selects the configured/default model; undefined retains the thread setting. */
  model?: string
  image?: string
  outputSchema?: unknown
  mapCommentaryText?(text: string): string | null
  streamText?: boolean
  onText?(text: string): void
  onSystem?(text: string): void
  onQuestion?(question: AgentQuestion): void
  onActivity?(event: AgentActivityEvent): void
}

interface PendingRpc {
  resolve(value: unknown): void
  reject(error: Error): void
}

interface ActiveTurn {
  text: string
  structured: boolean
  outputChars: number
  whitespaceRun: number
  timeout?: ReturnType<typeof setTimeout>
  streamText: boolean
  mapCommentaryText?: CodexAppServerTurn['mapCommentaryText']
  messagePhases: Map<string, string>
  agentMessagesWithDelta: Set<string>
  pendingMessageDeltas: Map<string, string>
  reasoningWithDelta: Set<string>
  callbacks: Pick<CodexAppServerTurn, 'onText' | 'onSystem' | 'onQuestion' | 'onActivity'>
  resolve(text: string): void
  reject(error: Error): void
}

/** Bidirectional client for the versioned protocol exposed by `codex app-server`. */
export class CodexAppServerClient {
  private process: AgentControlProcess | null = null
  private startPromise: Promise<void> | null = null
  private nextRpcId = 1
  private nextQuestionId = 1
  private pendingRpc = new Map<JsonRpcId, PendingRpc>()
  private questionRequests = new Map<string, {
    rpcId: JsonRpcId
    result(answer: AgentQuestionAnswer): unknown
  }>()
  private activeTurn: ActiveTurn | null = null
  private thread: string | null
  private sandboxMode: string | null = null
  private modelCatalog: Promise<AgentModel[]> | null = null
  private defaultModel: string | null = null
  private modelOverride: string | null = null
  private connectionVersion = 0
  private readonly options: CodexAppServerOptions

  constructor(options: CodexAppServerOptions) {
    this.options = options
    this.thread = options.initialThreadId ?? null
  }

  get threadId(): string | null {
    return this.thread
  }

  async listModels(refresh = false): Promise<AgentModel[]> {
    await this.ensureStarted()
    if (!this.modelCatalog || refresh) {
      this.modelCatalog = this.readModelCatalog().catch((error) => {
        this.modelCatalog = null
        throw error
      })
    }
    return this.modelCatalog
  }

  private async readModelCatalog(): Promise<AgentModel[]> {
    const models = new Map<string, AgentModel>()
    const cursors = new Set<string>()
    let cursor: string | null = null
    do {
      const page = parseCodexModelPage(await this.request('model/list', {
        limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}),
      }))
      for (const model of page.models) models.set(model.id, model)
      cursor = page.nextCursor
      if (cursor && cursors.has(cursor)) throw new Error('Codex model catalog repeated a page cursor')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    const catalog = [...models.values()]
    // Per-turn overrides persist in Codex. Resolve the default explicitly so clearing the
    // picker can restore it instead of accidentally retaining the last selected model.
    let configured: string | null = null
    try {
      configured = nestedString(await this.request('config/read', { includeLayers: false }), 'config', 'model')
    } catch {
      // Older wrappers may expose model/list without config/read.
    }
    this.defaultModel = configured || catalog.find((model) => model.isDefault)?.id || this.defaultModel
    return catalog
  }

  async runTurn(turn: CodexAppServerTurn): Promise<string> {
    await this.ensureStarted(turn.model)
    if (!this.thread) throw new Error('Codex app-server did not create a thread')
    if (this.activeTurn) throw new Error('Codex app-server already has an active turn')
    const selectedModel = turn.model?.trim() || null
    if (turn.model !== undefined && !selectedModel && this.modelOverride) {
      await this.listModels(true)
      if (!this.defaultModel) throw new Error('Codex default model is unavailable; select a model explicitly')
    }
    const model = selectedModel || (turn.model !== undefined ? this.defaultModel : null)

    const completed = new Promise<string>((resolve, reject) => {
      const active: ActiveTurn = {
        text: '',
        structured: turn.outputSchema != null,
        outputChars: 0,
        whitespaceRun: 0,
        streamText: turn.streamText === true,
        mapCommentaryText: turn.mapCommentaryText,
        messagePhases: new Map(),
        agentMessagesWithDelta: new Set(),
        pendingMessageDeltas: new Map(),
        reasoningWithDelta: new Set(),
        callbacks: turn,
        resolve: (text) => { clearTimeout(active.timeout); resolve(text) },
        reject: (error) => { clearTimeout(active.timeout); reject(error) },
      }
      this.activeTurn = active
      this.armTurnTimeout(active)
    })
    // A process can fail while turn/start is still pending; attach a rejection handler now.
    void completed.catch(() => {})
    turn.onActivity?.({ type: 'status', status: 'working' })
    try {
      await this.request('turn/start', {
        threadId: this.thread,
        input: [
          { type: 'text', text: turn.prompt },
          ...(turn.image ? [{ type: 'localImage', path: turn.image }] : []),
        ],
        summary: 'detailed',
        effort: 'medium',
        ...(model ? { model } : {}),
        ...(turn.outputSchema == null ? {} : { outputSchema: turn.outputSchema }),
      })
      if (turn.model !== undefined) this.modelOverride = selectedModel
      return await completed
    } catch (error) {
      void this.disconnect(asError(error)).catch(() => {})
      throw error
    }
  }

  async answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    await this.ensureStarted()
    const pending = this.questionRequests.get(answer.requestId)
    if (!pending) throw new Error(`Codex question is no longer pending: ${answer.requestId}`)
    this.questionRequests.delete(answer.requestId)
    await this.write({ id: pending.rpcId, result: pending.result(answer) })
    if (this.activeTurn && this.questionRequests.size === 0) this.armTurnTimeout(this.activeTurn)
  }

  async dispose(): Promise<void> {
    await this.disconnect(new Error('Codex app-server stopped'))
  }

  private async disconnect(error: Error): Promise<void> {
    const process = this.process
    this.connectionVersion++
    this.process = null
    this.startPromise = null
    this.modelCatalog = null
    this.failAll(error)
    if (process) await process.stop()
  }

  private ensureStarted(initialModel?: string): Promise<void> {
    if (!this.startPromise) {
      const starting = this.start(initialModel)
      const version = this.connectionVersion
      this.startPromise = starting.catch((error) => {
        if (version === this.connectionVersion) void this.disconnect(asError(error)).catch(() => {})
        throw error
      })
    }
    return this.startPromise
  }

  private async start(initialModel?: string): Promise<void> {
    const version = ++this.connectionVersion
    const started = await AgentControlProcess.startCodex(
      this.options.bin,
      this.options.cwd,
      this.options.readOnly,
      (event) => { if (version === this.connectionVersion) this.onProcessEvent(event) },
    )
    if (version !== this.connectionVersion) {
      await started.process.stop()
      throw new Error('Codex startup was cancelled')
    }
    this.process = started.process
    this.sandboxMode = started.sandboxMode
    await this.request('initialize', {
      clientInfo: { name: 'flowm', title: 'FlowM', version: '0.8.0' },
      capabilities: { experimentalApi: true },
    })
    await this.write({ method: 'initialized' })

    const threadParams = {
      cwd: this.options.cwd,
      approvalPolicy: 'on-request',
      sandbox: this.sandboxMode,
      serviceName: 'flowm',
      ...(initialModel?.trim() ? { model: initialModel.trim() } : {}),
    }
    const response = this.thread
      ? await this.request('thread/resume', { threadId: this.thread, ...threadParams })
      : await this.request('thread/start', threadParams)
    const id = nestedString(response, 'thread', 'id')
    if (!id) throw new Error('Codex app-server returned no thread id')
    this.thread = id
    const model = response && typeof response === 'object' ? (response as Record<string, unknown>).model : null
    if (typeof model === 'string' && model) this.defaultModel = model
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRpcId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        void this.disconnect(new Error(`Codex ${method} timed out after 60 seconds. Please retry.`)).catch(() => {})
      }, RPC_TIMEOUT_MS)
      const clear = () => { clearTimeout(timeout); this.pendingRpc.delete(id) }
      this.pendingRpc.set(id, {
        resolve: (value) => { clear(); resolve(value) },
        reject: (error) => { clear(); reject(error) },
      })
      void this.write({ id, method, params }).catch((error) => {
        this.pendingRpc.get(id)?.reject(asError(error))
      })
    })
  }

  private write(message: JsonRpcMessage): Promise<void> {
    if (!this.process) return Promise.reject(new Error('Codex app-server is not running'))
    return this.process.write(message)
  }

  private onProcessEvent(event: AgentControlProcessEvent): void {
    if (event.kind === 'stdout') {
      this.onMessage(event.line)
    } else if (event.kind === 'stderr') {
      const line = cleanAgentDiagnostic(event.line)
      if (line) this.activeTurn?.callbacks.onActivity?.({
        type: 'warning', id: 'codex-stderr', text: 'Codex diagnostics', detail: line,
      })
    } else {
      void this.disconnect(new Error(`Codex app-server exited${event.code == null ? '' : ` with code ${event.code}`}`)).catch(() => {})
    }
  }

  private onMessage(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }

    if (message.id != null && !message.method) {
      const pending = this.pendingRpc.get(message.id)
      if (!pending) return
      this.pendingRpc.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || 'Codex app-server request failed'))
      else pending.resolve(message.result)
      return
    }

    if (message.id != null && message.method) {
      this.onServerRequest(message)
      return
    }
    this.onNotification(message.method, message.params)
  }

  private onServerRequest(message: JsonRpcMessage): void {
    if (message.id == null) return
    const requestId = `codex-question-${this.nextQuestionId++}`
    const pending = parseCodexServerRequest(requestId, message.method ?? '', message.params)
    if (!pending) {
      void this.write({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method ?? '(missing)'}` },
      })
      return
    }
    if (!this.activeTurn?.callbacks.onQuestion) {
      void this.write({ id: message.id, error: { code: -32602, message: 'Question cannot be displayed' } })
      return
    }
    this.questionRequests.set(requestId, { rpcId: message.id, result: pending.result })
    clearTimeout(this.activeTurn.timeout) // Waiting for the user's answer is not a model timeout.
    this.activeTurn.callbacks.onQuestion(pending.question)
  }

  private armTurnTimeout(active: ActiveTurn): void {
    clearTimeout(active.timeout)
    active.timeout = setTimeout(() => {
      if (this.activeTurn === active) {
        void this.disconnect(new Error('Codex produced no completed response within 5 minutes. Please retry.')).catch(() => {})
      }
    }, TURN_TIMEOUT_MS)
  }

  private acceptOutput(active: ActiveTurn, text: string, replace = false): boolean {
    if (!active.structured) return true
    active.outputChars = (replace ? 0 : active.outputChars) + text.length
    if (replace) active.whitespaceRun = 0
    let error = active.outputChars > MAX_OUTPUT_CHARS ? 'Codex structured output exceeded the size limit.' : ''
    for (const character of text) {
      if (error) break
      active.whitespaceRun = /\s/.test(character) ? active.whitespaceRun + 1 : 0
      if (active.whitespaceRun >= MAX_WHITESPACE_RUN) error = 'Codex generated excessive whitespace instead of a valid canvas response.'
    }
    if (!error) return true
    void this.disconnect(new Error(`${error} Generation was stopped; please retry.`)).catch(() => {})
    return false
  }

  private onNotification(method: string | undefined, params: unknown): void {
    const active = this.activeTurn
    if (!active || !params || typeof params !== 'object') return
    const value = params as Record<string, unknown>

    if (method === 'error') {
      const detail = errorMessage(value.error ?? value)
      if (value.willRetry === true) {
        active.callbacks.onActivity?.({ type: 'warning', id: 'codex-retry', text: 'Codex is retrying', detail })
      } else {
        void this.disconnect(new Error(detail)).catch(() => {})
      }
      return
    }

    if (method === 'item/agentMessage/delta' && typeof value.delta === 'string') {
      if (!this.acceptOutput(active, value.delta)) return
      const itemId = typeof value.itemId === 'string' ? value.itemId : 'agent-message'
      const phase = active.messagePhases.get(itemId)
      active.agentMessagesWithDelta.add(itemId)
      this.onAgentMessageDelta(active, itemId, phase, value.delta)
      return
    }
    if ((method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta')
      && typeof value.delta === 'string') {
      const itemId = typeof value.itemId === 'string' ? value.itemId : 'reasoning'
      active.reasoningWithDelta.add(itemId)
      active.callbacks.onActivity?.({
        type: 'thinking_delta',
        id: itemId,
        delta: value.delta,
      })
      return
    }
    if (method === 'item/started') {
      const item = value.item
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        if (record.type === 'agentMessage' && typeof record.id === 'string' && typeof record.phase === 'string') {
          active.messagePhases.set(record.id, record.phase)
          this.flushPendingAgentMessage(active, record.id, record.phase)
        }
        const activity = codexActivityForItem(item)
        if (activity) active.callbacks.onActivity?.(activity)
      }
      return
    }
    if (method === 'item/completed') {
      const item = value.item
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        if (record.type === 'agentMessage' && typeof record.id === 'string' && typeof record.text === 'string') {
          if (!this.acceptOutput(active, record.text, true)) return
          const phase = typeof record.phase === 'string'
            ? record.phase
            : active.messagePhases.get(record.id)
          if (phase) active.messagePhases.set(record.id, phase)
          this.flushPendingAgentMessage(active, record.id, phase)
          if (phase === 'commentary' && active.mapCommentaryText) {
            const commentary = active.mapCommentaryText(record.text)
            if (commentary) active.callbacks.onActivity?.({
              type: 'commentary_delta', id: record.id, delta: commentary,
            })
          } else if (!active.agentMessagesWithDelta.has(record.id)) {
            this.onAgentMessageDelta(active, record.id, phase, record.text)
          }
          if (phase === 'final_answer') active.text = record.text
        }
        if (record.type === 'reasoning' && typeof record.id === 'string'
          && !active.reasoningWithDelta.has(record.id)) {
          const summary = codexReasoningText(item)
          if (summary) active.callbacks.onActivity?.({
            type: 'thinking_delta', id: record.id, delta: summary,
          })
        }
        const activity = codexActivityForItem(item)
        if (activity) active.callbacks.onActivity?.(activity)
      }
      return
    }
    if (method === 'turn/completed') {
      const turn = value.turn
      const error = turn && typeof turn === 'object' ? (turn as Record<string, unknown>).error : null
      const status = turn && typeof turn === 'object' ? (turn as Record<string, unknown>).status : null
      const completedText = codexCompletedTurnText(value)
      if (completedText != null) {
        if (!this.acceptOutput(active, completedText, true)) return
        active.text = completedText
      }
      this.activeTurn = null
      this.questionRequests.clear()
      if (error || status === 'failed' || status === 'interrupted' || !active.text.trim()) {
        active.callbacks.onActivity?.({ type: 'status', status: 'failed' })
        active.reject(new Error(error ? errorMessage(error) : `Codex ${status === 'interrupted' ? 'was interrupted' : 'returned no usable response'}. Please retry.`))
      } else {
        active.callbacks.onActivity?.({ type: 'status', status: 'completed' })
        active.resolve(active.text)
      }
    }
  }

  private onAgentMessageDelta(
    active: ActiveTurn,
    itemId: string,
    phase: string | undefined,
    delta: string,
  ): void {
    if (phase === 'commentary') {
      if (active.mapCommentaryText) return
      const activity = codexCommentaryEvent(itemId, phase, delta)
      if (activity) active.callbacks.onActivity?.(activity)
      return
    }
    if (phase === 'final_answer') {
      active.text += delta
      if (active.streamText) active.callbacks.onText?.(delta)
      return
    }
    active.pendingMessageDeltas.set(
      itemId,
      (active.pendingMessageDeltas.get(itemId) ?? '') + delta,
    )
  }

  private flushPendingAgentMessage(
    active: ActiveTurn,
    itemId: string,
    phase: string | undefined,
  ): void {
    const pending = active.pendingMessageDeltas.get(itemId)
    if (!pending || !phase) return
    active.pendingMessageDeltas.delete(itemId)
    this.onAgentMessageDelta(active, itemId, phase, pending)
  }

  private failAll(error: Error): void {
    for (const pending of this.pendingRpc.values()) pending.reject(error)
    this.pendingRpc.clear()
    this.questionRequests.clear()
    const active = this.activeTurn
    this.activeTurn = null
    active?.callbacks.onActivity?.({ type: 'status', status: 'failed' })
    active?.reject(error)
  }
}

function nestedString(value: unknown, key: string, nested: string): string | null {
  if (!value || typeof value !== 'object') return null
  const child = (value as Record<string, unknown>)[key]
  if (!child || typeof child !== 'object') return null
  const result = (child as Record<string, unknown>)[nested]
  return typeof result === 'string' ? result : null
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message
  }
  return JSON.stringify(value)
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : JSON.stringify(value))
}
