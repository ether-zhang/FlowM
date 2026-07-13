import type { AgentActivityEvent, AgentQuestion, AgentQuestionAnswer } from './types'
import { AgentControlProcess, type AgentControlProcessEvent } from './agentControlProcess'
import { cleanAgentDiagnostic } from './diagnostics'
import {
  codexCompletedTurnText,
  codexActivityForItem,
  codexCommentaryEvent,
  codexReasoningText,
  parseCodexServerRequest,
  type JsonRpcId,
  type JsonRpcMessage,
} from './codexAppServerProtocol'

export interface CodexAppServerOptions {
  bin?: string
  cwd: string
  initialThreadId?: string
  readOnly: boolean
}

export interface CodexAppServerTurn {
  prompt: string
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
  private readonly options: CodexAppServerOptions

  constructor(options: CodexAppServerOptions) {
    this.options = options
    this.thread = options.initialThreadId ?? null
  }

  get threadId(): string | null {
    return this.thread
  }

  async runTurn(turn: CodexAppServerTurn): Promise<string> {
    await this.ensureStarted()
    if (!this.thread) throw new Error('Codex app-server did not create a thread')
    if (this.activeTurn) throw new Error('Codex app-server already has an active turn')

    const completed = new Promise<string>((resolve, reject) => {
      this.activeTurn = {
        text: '',
        streamText: turn.streamText === true,
        mapCommentaryText: turn.mapCommentaryText,
        messagePhases: new Map(),
        agentMessagesWithDelta: new Set(),
        pendingMessageDeltas: new Map(),
        reasoningWithDelta: new Set(),
        callbacks: turn,
        resolve,
        reject,
      }
    })
    turn.onActivity?.({ type: 'status', status: 'working' })
    try {
      await this.request('turn/start', {
        threadId: this.thread,
        input: [
          { type: 'text', text: turn.prompt },
          ...(turn.image ? [{ type: 'localImage', path: turn.image }] : []),
        ],
        summary: 'detailed',
        ...(turn.outputSchema == null ? {} : { outputSchema: turn.outputSchema }),
      })
      return await completed
    } catch (error) {
      turn.onActivity?.({ type: 'status', status: 'failed' })
      this.activeTurn = null
      throw error
    }
  }

  async answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    await this.ensureStarted()
    const pending = this.questionRequests.get(answer.requestId)
    if (!pending) throw new Error(`Codex question is no longer pending: ${answer.requestId}`)
    this.questionRequests.delete(answer.requestId)
    await this.write({ id: pending.rpcId, result: pending.result(answer) })
  }

  async dispose(): Promise<void> {
    const process = this.process
    this.process = null
    this.startPromise = null
    this.failAll(new Error('Codex app-server stopped'))
    if (process) await process.stop()
  }

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.start()
    return this.startPromise
  }

  private async start(): Promise<void> {
    const started = await AgentControlProcess.startCodex(
      this.options.bin,
      this.options.cwd,
      this.options.readOnly,
      (event) => this.onProcessEvent(event),
    )
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
    }
    const response = this.thread
      ? await this.request('thread/resume', { threadId: this.thread, ...threadParams })
      : await this.request('thread/start', threadParams)
    const id = nestedString(response, 'thread', 'id')
    if (!id) throw new Error('Codex app-server returned no thread id')
    this.thread = id
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRpcId++
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(id, { resolve, reject })
      void this.write({ id, method, params }).catch((error) => {
        this.pendingRpc.delete(id)
        reject(asError(error))
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
      this.failAll(new Error(`Codex app-server exited${event.code == null ? '' : ` with code ${event.code}`}`))
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
    this.activeTurn.callbacks.onQuestion(pending.question)
  }

  private onNotification(method: string | undefined, params: unknown): void {
    const active = this.activeTurn
    if (!active || !params || typeof params !== 'object') return
    const value = params as Record<string, unknown>

    if (method === 'item/agentMessage/delta' && typeof value.delta === 'string') {
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
      const completedText = codexCompletedTurnText(value)
      if (completedText != null) active.text = completedText
      this.activeTurn = null
      this.questionRequests.clear()
      if (error) {
        active.callbacks.onActivity?.({ type: 'status', status: 'failed' })
        active.reject(new Error(errorMessage(error)))
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
