import {
  ClaudeControlClient,
  isClaudeControlUnavailableError,
  type AgentQuestionAnswer,
} from '../agentControl'
import { cleanAgentDiagnostic } from '../agentControl/diagnostics'
import { claudeRun } from '../agentControl/claudeCli'
import {
  extractSessionId,
  extractStructured,
  interpretClaudeLine,
} from '../agentControl/claudeStream'
import type { TurnCallbacks } from './adapter'

export interface ClaudeTransportOptions {
  bin?: string
  model?: string
  cwd: string
  jsonSchema?: unknown
  initialSessionId?: string
  disallowedTools?: string[]
  appendSystemPrompt?: string
}

export interface ClaudeTransportResult {
  structured: unknown
  prose: string
}

type ClaudeTransportCallbacks = Partial<
  Pick<TurnCallbacks, 'onText' | 'onSystem' | 'onQuestion' | 'onActivity'>
>

export interface ClaudeTurnTransport {
  readonly kind: 'control' | 'legacy'
  readonly sessionId: string | null
  runTurn(prompt: string, callbacks: ClaudeTransportCallbacks): Promise<ClaudeTransportResult>
  answerQuestion(answer: AgentQuestionAnswer): Promise<void>
  dispose(): Promise<void>
}

export interface ClaudeTransportFactory {
  createControl(options: ClaudeTransportOptions): ClaudeTurnTransport
  createLegacy(options: ClaudeTransportOptions): ClaudeTurnTransport
}

class ClaudeControlTransport implements ClaudeTurnTransport {
  readonly kind = 'control'
  private readonly client: ClaudeControlClient

  constructor(options: ClaudeTransportOptions) {
    this.client = new ClaudeControlClient(options)
  }

  get sessionId(): string | null {
    return this.client.sessionId
  }

  async runTurn(
    prompt: string,
    callbacks: ClaudeTransportCallbacks,
  ): Promise<ClaudeTransportResult> {
    return this.client.runTurn({
      prompt,
      onText: callbacks.onText,
      onSystem: callbacks.onSystem,
      onQuestion: callbacks.onQuestion,
      onActivity: callbacks.onActivity,
    })
  }

  answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    return this.client.answerQuestion(answer)
  }

  dispose(): Promise<void> {
    return this.client.dispose()
  }
}

class ClaudeLegacyTransport implements ClaudeTurnTransport {
  readonly kind = 'legacy'
  private session: string | null
  private readonly options: ClaudeTransportOptions

  constructor(options: ClaudeTransportOptions) {
    this.options = options
    this.session = options.initialSessionId ?? null
  }

  get sessionId(): string | null {
    return this.session
  }

  async runTurn(
    prompt: string,
    callbacks: ClaudeTransportCallbacks,
  ): Promise<ClaudeTransportResult> {
    let structured: unknown = null
    let prose = ''
    let exitCode: number | null | undefined
    const diagnostics: string[] = []
    callbacks.onActivity?.({ type: 'status', status: 'working' })

    try {
      await claudeRun(
        prompt,
        this.options.cwd,
        (event) => {
          if (event.kind === 'stdout') {
            for (const item of interpretClaudeLine(event.line)) {
              if (item.kind === 'system') callbacks.onSystem?.(item.text)
              else prose += item.text
            }
            const sessionId = extractSessionId(event.line)
            if (sessionId) this.session = sessionId
            const output = extractStructured(event.line)
            if (output != null) structured = output
          } else if (event.kind === 'stderr') {
            const line = cleanAgentDiagnostic(event.line)
            if (!line) return
            diagnostics.push(line)
            callbacks.onActivity?.({
              type: 'warning',
              id: 'claude-legacy-stderr',
              text: 'Claude diagnostics',
              detail: line,
            })
          } else {
            exitCode = event.code
          }
        },
        this.options.bin,
        this.options.jsonSchema,
        this.session ?? undefined,
        this.options.disallowedTools,
        this.options.appendSystemPrompt,
        this.options.model,
      )
    } catch (error) {
      callbacks.onActivity?.({ type: 'status', status: 'failed' })
      throw error
    }

    if (exitCode != null && exitCode !== 0) {
      callbacks.onActivity?.({ type: 'status', status: 'failed' })
      const detail = diagnostics.at(-1)
      throw new Error(
        `Claude compatibility process exited with code ${exitCode}${detail ? `: ${detail}` : ''}`,
      )
    }

    callbacks.onActivity?.({ type: 'status', status: 'completed' })
    return { structured, prose: legacyAnswerProse(structured, prose) }
  }

  answerQuestion(): Promise<void> {
    return Promise.reject(
      new Error('Interactive Claude questions require Agent SDK control support'),
    )
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }
}

const defaultClaudeTransportFactory: ClaudeTransportFactory = {
  createControl: (options) => new ClaudeControlTransport(options),
  createLegacy: (options) => new ClaudeLegacyTransport(options),
}

function legacyAnswerProse(structured: unknown, prose: string): string {
  const output = structured as { reply?: unknown; operations?: unknown } | null
  const hasStructuredReply = typeof output?.reply === 'string' && output.reply.trim() !== ''
  const hasOperations = Array.isArray(output?.operations) && output.operations.length > 0
  return hasStructuredReply || hasOperations ? '' : prose
}

/**
 * Prefer Claude's bidirectional control protocol, but negotiate down to the established
 * one-shot `claude -p` transport when a compatible wrapper cannot complete initialization.
 * Runtime failures after a successful handshake remain control errors and never trigger replay.
 */
export class CompatibleClaudeTransport implements ClaudeTurnTransport {
  private transport: ClaudeTurnTransport
  private readonly options: ClaudeTransportOptions
  private readonly factory: ClaudeTransportFactory

  constructor(
    options: ClaudeTransportOptions,
    factory: ClaudeTransportFactory = defaultClaudeTransportFactory,
  ) {
    this.options = options
    this.factory = factory
    this.transport = factory.createControl(options)
  }

  get kind(): 'control' | 'legacy' {
    return this.transport.kind
  }

  get sessionId(): string | null {
    return this.transport.sessionId
  }

  async runTurn(
    prompt: string,
    callbacks: ClaudeTransportCallbacks,
  ): Promise<ClaudeTransportResult> {
    try {
      return await this.transport.runTurn(prompt, callbacks)
    } catch (error) {
      if (this.transport.kind !== 'control' || !isClaudeControlUnavailableError(error)) {
        throw error
      }
      const sessionId = this.transport.sessionId ?? this.options.initialSessionId
      try {
        await this.transport.dispose()
      } catch {
        // Handshake cleanup must not hide the compatibility path.
      }
      this.transport = this.factory.createLegacy({
        ...this.options,
        initialSessionId: sessionId,
      })
      callbacks.onActivity?.({
        type: 'warning',
        id: 'claude-control-fallback',
        text: 'Claude compatibility mode',
        detail:
          'The configured Claude command does not support Agent SDK control. ' +
          'FlowM is using one-shot CLI mode; interactive tool approvals are unavailable.',
      })
      return this.transport.runTurn(prompt, callbacks)
    }
  }

  answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    return this.transport.answerQuestion(answer)
  }

  dispose(): Promise<void> {
    return this.transport.dispose()
  }
}
