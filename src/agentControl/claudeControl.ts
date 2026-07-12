import type { AgentQuestion, AgentQuestionAnswer } from './types'
import { AgentControlProcess, type AgentControlProcessEvent } from './agentControlProcess'
import {
  claudeQuestionUpdatedInput,
  parseClaudeQuestion,
  type ClaudePendingQuestion,
} from './claudeControlProtocol'

export interface ClaudeControlOptions {
  bin?: string
  cwd: string
  jsonSchema?: unknown
  initialSessionId?: string
  disallowedTools?: string[]
  appendSystemPrompt?: string
}

export interface ClaudeControlTurn {
  prompt: string
  streamText?: boolean
  onText?(text: string): void
  onSystem?(text: string): void
  onQuestion?(question: AgentQuestion): void
}

export interface ClaudeControlTurnResult {
  structured: unknown
  prose: string
  rawResult: unknown
}

interface PendingControlRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

interface ActiveTurn {
  prose: string
  streamText: boolean
  callbacks: Pick<ClaudeControlTurn, 'onText' | 'onSystem' | 'onQuestion'>
  resolve(result: ClaudeControlTurnResult): void
  reject(error: Error): void
}

/** Minimal host for Claude Code's documented Agent SDK control protocol. */
export class ClaudeControlClient {
  private process: AgentControlProcess | null = null
  private startPromise: Promise<void> | null = null
  private nextControlId = 1
  private nextQuestionId = 1
  private pendingControl = new Map<string, PendingControlRequest>()
  private pendingQuestions = new Map<string, ClaudePendingQuestion>()
  private activeTurn: ActiveTurn | null = null
  private session: string | null
  private readonly options: ClaudeControlOptions

  constructor(options: ClaudeControlOptions) {
    this.options = options
    this.session = options.initialSessionId ?? null
  }

  get sessionId(): string | null {
    return this.session
  }

  async runTurn(turn: ClaudeControlTurn): Promise<ClaudeControlTurnResult> {
    await this.ensureStarted()
    if (this.activeTurn) throw new Error('Claude control client already has an active turn')
    const result = new Promise<ClaudeControlTurnResult>((resolve, reject) => {
      this.activeTurn = {
        prose: '',
        streamText: turn.streamText === true,
        callbacks: turn,
        resolve,
        reject,
      }
    })
    try {
      await this.write({
        type: 'user',
        session_id: this.session ?? '',
        parent_tool_use_id: null,
        message: { role: 'user', content: turn.prompt },
      })
      return await result
    } catch (error) {
      this.activeTurn = null
      throw error
    }
  }

  async answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    await this.ensureStarted()
    const pending = this.pendingQuestions.get(answer.requestId)
    if (!pending) throw new Error(`Claude question is no longer pending: ${answer.requestId}`)
    this.pendingQuestions.delete(answer.requestId)
    await this.sendControlSuccess(pending.controlRequestId, {
      behavior: 'allow',
      updatedInput: claudeQuestionUpdatedInput(pending, answer),
    })
  }

  async dispose(): Promise<void> {
    const process = this.process
    this.process = null
    this.startPromise = null
    this.failAll(new Error('Claude control process stopped'))
    if (process) await process.stop()
  }

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.start()
    return this.startPromise
  }

  private async start(): Promise<void> {
    this.process = await AgentControlProcess.startClaude({
      bin: this.options.bin,
      cwd: this.options.cwd,
      jsonSchema: this.options.jsonSchema,
      resume: this.options.initialSessionId,
      disallowedTools: this.options.disallowedTools,
      appendSystemPrompt: this.options.appendSystemPrompt,
    }, (event) => this.onProcessEvent(event))
    await this.sendControlRequest({ subtype: 'initialize', hooks: null })
  }

  private sendControlRequest(request: Record<string, unknown>): Promise<unknown> {
    const requestId = `flowm-${this.nextControlId++}`
    return new Promise((resolve, reject) => {
      this.pendingControl.set(requestId, { resolve, reject })
      void this.write({ type: 'control_request', request_id: requestId, request }).catch((error) => {
        this.pendingControl.delete(requestId)
        reject(asError(error))
      })
    })
  }

  private sendControlSuccess(requestId: string, response: unknown): Promise<void> {
    return this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    })
  }

  private sendControlError(requestId: string, error: string): Promise<void> {
    return this.write({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    })
  }

  private write(message: unknown): Promise<void> {
    if (!this.process) return Promise.reject(new Error('Claude control process is not running'))
    return this.process.write(message)
  }

  private onProcessEvent(event: AgentControlProcessEvent): void {
    if (event.kind === 'stdout') {
      this.onMessage(event.line)
    } else if (event.kind === 'stderr') {
      this.activeTurn?.callbacks.onSystem?.(`⚠ ${event.line}`)
    } else {
      this.failAll(new Error(`Claude control process exited${event.code == null ? '' : ` with code ${event.code}`}`))
    }
  }

  private onMessage(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const type = message.type
    if (type === 'control_response') {
      this.onControlResponse(message.response)
    } else if (type === 'control_request') {
      this.onControlRequest(message)
    } else if (type === 'control_cancel_request') {
      const requestId = typeof message.request_id === 'string' ? message.request_id : ''
      for (const [id, pending] of this.pendingQuestions) {
        if (pending.controlRequestId === requestId) this.pendingQuestions.delete(id)
      }
    } else if (type === 'system' && message.subtype === 'init') {
      if (typeof message.session_id === 'string') this.session = message.session_id
    } else if (type === 'assistant') {
      this.onAssistantMessage(message)
    } else if (type === 'result') {
      this.onResult(message)
    }
  }

  private onControlResponse(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const response = value as Record<string, unknown>
    const requestId = typeof response.request_id === 'string' ? response.request_id : ''
    const pending = this.pendingControl.get(requestId)
    if (!pending) return
    this.pendingControl.delete(requestId)
    if (response.subtype === 'error') pending.reject(new Error(String(response.error ?? 'Claude control request failed')))
    else pending.resolve(response.response)
  }

  private onControlRequest(message: Record<string, unknown>): void {
    const controlRequestId = typeof message.request_id === 'string' ? message.request_id : ''
    const request = message.request
    if (!controlRequestId || !request || typeof request !== 'object') return
    const data = request as Record<string, unknown>
    if (data.subtype !== 'can_use_tool') {
      void this.sendControlError(controlRequestId, `Unsupported control request: ${String(data.subtype)}`)
      return
    }

    const input = data.input && typeof data.input === 'object'
      ? data.input as Record<string, unknown>
      : {}
    if (data.tool_name !== 'AskUserQuestion') {
      void this.sendControlSuccess(controlRequestId, { behavior: 'allow', updatedInput: input })
      return
    }

    const requestId = `claude-question-${this.nextQuestionId++}`
    const pending = parseClaudeQuestion(requestId, controlRequestId, input)
    if (!pending || !this.activeTurn?.callbacks.onQuestion) {
      void this.sendControlSuccess(controlRequestId, {
        behavior: 'deny',
        message: 'The client cannot display this question.',
      })
      return
    }
    this.pendingQuestions.set(requestId, pending)
    this.activeTurn.callbacks.onQuestion(pending.question)
  }

  private onAssistantMessage(message: Record<string, unknown>): void {
    const active = this.activeTurn
    if (!active) return
    const value = message.message
    if (!value || typeof value !== 'object') return
    const content = (value as Record<string, unknown>).content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const item = block as Record<string, unknown>
      if (item.type === 'text' && typeof item.text === 'string') {
        active.prose += item.text
        if (active.streamText) active.callbacks.onText?.(item.text)
      } else if (item.type === 'tool_use' && typeof item.name === 'string') {
        active.callbacks.onSystem?.(`🔧 ${item.name}`)
      }
    }
  }

  private onResult(message: Record<string, unknown>): void {
    const active = this.activeTurn
    if (!active) return
    this.activeTurn = null
    this.pendingQuestions.clear()
    if (message.is_error === true) {
      active.reject(new Error(typeof message.result === 'string' ? message.result : 'Claude turn failed'))
      return
    }
    active.resolve({
      structured: message.structured_output ?? null,
      prose: active.prose,
      rawResult: message,
    })
  }

  private failAll(error: Error): void {
    for (const pending of this.pendingControl.values()) pending.reject(error)
    this.pendingControl.clear()
    this.pendingQuestions.clear()
    const active = this.activeTurn
    this.activeTurn = null
    active?.reject(error)
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : JSON.stringify(value))
}
