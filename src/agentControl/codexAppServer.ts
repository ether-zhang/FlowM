import type { AgentQuestion, AgentQuestionAnswer } from './types'
import { AgentControlProcess, type AgentControlProcessEvent } from './agentControlProcess'
import {
  codexCompletedTurnText,
  codexQuestionResult,
  parseCodexQuestion,
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
  streamText?: boolean
  onText?(text: string): void
  onSystem?(text: string): void
  onQuestion?(question: AgentQuestion): void
}

interface PendingRpc {
  resolve(value: unknown): void
  reject(error: Error): void
}

interface ActiveTurn {
  text: string
  streamText: boolean
  callbacks: Pick<CodexAppServerTurn, 'onText' | 'onSystem' | 'onQuestion'>
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
  private questionRequests = new Map<string, JsonRpcId>()
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
        callbacks: turn,
        resolve,
        reject,
      }
    })
    try {
      await this.request('turn/start', {
        threadId: this.thread,
        input: [
          { type: 'text', text: turn.prompt },
          ...(turn.image ? [{ type: 'localImage', path: turn.image }] : []),
        ],
        ...(turn.outputSchema == null ? {} : { outputSchema: turn.outputSchema }),
      })
      return await completed
    } catch (error) {
      this.activeTurn = null
      throw error
    }
  }

  async answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    await this.ensureStarted()
    const rpcId = this.questionRequests.get(answer.requestId)
    if (rpcId == null) throw new Error(`Codex question is no longer pending: ${answer.requestId}`)
    this.questionRequests.delete(answer.requestId)
    await this.write({ id: rpcId, result: codexQuestionResult(answer) })
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
      approvalPolicy: 'never',
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
      this.activeTurn?.callbacks.onSystem?.(`⚠ ${event.line}`)
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
    if (message.method !== 'item/tool/requestUserInput') {
      void this.write({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method ?? '(missing)'}` },
      })
      return
    }

    const requestId = `codex-question-${this.nextQuestionId++}`
    const question = parseCodexQuestion(requestId, message.params)
    if (!question || !this.activeTurn?.callbacks.onQuestion) {
      void this.write({ id: message.id, error: { code: -32602, message: 'Question cannot be displayed' } })
      return
    }
    this.questionRequests.set(requestId, message.id)
    this.activeTurn.callbacks.onQuestion(question)
  }

  private onNotification(method: string | undefined, params: unknown): void {
    const active = this.activeTurn
    if (!active || !params || typeof params !== 'object') return
    const value = params as Record<string, unknown>

    if (method === 'item/agentMessage/delta' && typeof value.delta === 'string') {
      active.text += value.delta
      if (active.streamText) active.callbacks.onText?.(value.delta)
      return
    }
    if (method === 'item/started') {
      const item = value.item
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        if (record.type === 'commandExecution') {
          const command = Array.isArray(record.command) ? record.command.join(' ') : String(record.command ?? '')
          active.callbacks.onSystem?.(`🔧 ${command}`)
        } else if (record.type === 'mcpToolCall') {
          active.callbacks.onSystem?.(`🔧 ${String(record.tool ?? 'MCP tool')}`)
        }
      }
      return
    }
    if (method === 'item/completed') {
      const item = value.item
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        if (record.type === 'agentMessage' && typeof record.text === 'string') {
          const hadText = !!active.text
          if (record.phase === 'final_answer' || !active.text) active.text = record.text
          if (active.streamText && !hadText) active.callbacks.onText?.(record.text)
        }
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
      if (error) active.reject(new Error(errorMessage(error)))
      else active.resolve(active.text)
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pendingRpc.values()) pending.reject(error)
    this.pendingRpc.clear()
    this.questionRequests.clear()
    const active = this.activeTurn
    this.activeTurn = null
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
