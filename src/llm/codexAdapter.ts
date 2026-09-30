import type { LlmAdapter, RunTurnParams, TurnCallbacks } from './adapter'
import type { LlmMessage, LlmTurn } from './types'
import type { AgentQuestionAnswer } from '../agent'
import { writeCodexCanvasGuide, writeDesign } from '../agent/projectFiles'
import { CodexAppServerClient } from '../agentControl'
import { buildCanvasTurnOutputSchema, projectCanvasTurn } from './outputContract'

export class CodexAdapter implements LlmAdapter {
  private getCwd: () => string
  private getBin: () => string
  private getModel: () => string
  private initialSession: string | null
  private client: CodexAppServerClient | null = null
  private clientKey: string | null = null
  private sent = 0
  private turn = 0
  /** Re-write the project guide whenever either its project or semantic contract changes. */
  private guideKey: string | null = null
  private guidePath = '.flowm/codex-canvas.md'

  constructor(getCwd: () => string, getBin: () => string, initialSession: string | null = null, getModel: () => string = () => '') {
    this.getCwd = getCwd
    this.getBin = getBin
    this.initialSession = initialSession
    this.getModel = getModel
  }

  get sessionId(): string | null {
    return this.client?.threadId ?? this.initialSession
  }

  async answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    if (!this.client) throw new Error('Codex app-server is not running')
    await this.client.answerQuestion(answer)
  }

  async dispose(): Promise<void> {
    const client = this.client
    this.client = null
    this.clientKey = null
    if (client) await client.dispose()
  }

  async runTurn(params: RunTurnParams, cb: TurnCallbacks): Promise<LlmTurn> {
    const cwd = this.getCwd().trim()
    if (!cwd) throw new Error('请先打开工程')

    const guideKey = `${cwd}\0${params.system}`
    if (this.guideKey !== guideKey) {
      this.guidePath = await writeCodexCanvasGuide(cwd, params.system)
      this.guideKey = guideKey
    }

    const fresh = params.messages.slice(this.sent)
    const sentCount = params.messages.length
    const { prompt, image } = await this.composeDelta(fresh, cwd)
    const schema = buildCanvasTurnOutputSchema(params.tools, 'strict')
    const client = await this.ensureClient(cwd)
    this.turn++

    cb.onDebug?.(
      `▶ 实际发给 Codex · 第 ${this.turn} 轮\n` +
        `transport: app-server · thread: ${client.threadId ?? this.initialSession ?? '(新会话)'} · model: ${this.getModel().trim() || '(default)'} · output-schema: { reply, operations[] }\n` +
        `system: invocation-scoped guide -> ${this.guidePath}\n` +
        `cwd: ${cwd} · repo policy: read-only · sandbox: platform default · image: ${image ?? '(无)'}\n` +
        `本轮增量：${fresh.length} 条 / ${prompt.length} 字符\n${prompt}`,
    )

    const last = await client.runTurn({
      prompt,
      model: this.getModel().trim(),
      image,
      outputSchema: schema,
      onSystem: cb.onSystem,
      onQuestion: cb.onQuestion,
      onActivity: cb.onActivity,
    })
    const structured = parseStructured(last)
    if (!structured || typeof structured !== 'object' || !Array.isArray((structured as { operations?: unknown }).operations)) {
      throw new Error('Codex returned incomplete or invalid canvas JSON. No operations from this response were applied; please retry.')
    }
    const result = projectCanvasTurn(structured, { callIdPrefix: `codex-${this.turn}` })
    if (!result.text.trim() && !result.toolCalls.length && !result.question
      && (params.phase === 'finalize' || (params.phase === 'build' && !fresh.some((message) => message.role === 'tool')))) {
      throw new Error('Codex returned no answer or canvas operations. Please retry.')
    }
    this.sent = sentCount

    if (cb.onDebug) {
      const ops = Array.isArray((structured as { operations?: unknown })?.operations) ? ((structured as { operations: unknown[] }).operations) : []
      const geos = ops.filter((o) => !!o && typeof o === 'object' && (o as { op?: unknown }).op === 'create_geo') as { x?: unknown; y?: unknown }[]
      const withXY = geos.filter((o) => o.x != null || o.y != null).length
      cb.onDebug(
        `◀ Codex 原始返回 · 第 ${this.turn} 轮 · 操作 ${ops.length}（create_geo ${geos.length}，其中带坐标 ${withXY}）\n` +
          (last ?? '(无最终消息)'),
      )
    }
    console.info(
      `[CodexAdapter] turn ${this.turn}: sent ${prompt.length} chars / ${fresh.length} msgs · captured ${result.toolCalls.length} ops · session ${client.threadId ?? '(new)'}`,
    )
    return result
  }

  private async ensureClient(cwd: string): Promise<CodexAppServerClient> {
    const bin = this.getBin().trim()
    const key = `${cwd}\0${bin}`
    if (this.client && this.clientKey === key) return this.client
    const sessionId = this.sessionId
    if (this.client) await this.client.dispose()
    this.initialSession = sessionId
    this.client = new CodexAppServerClient({
      cwd,
      bin: bin || undefined,
      initialThreadId: this.initialSession ?? undefined,
      readOnly: true,
    })
    this.clientKey = key
    return this.client
  }

  private async composeDelta(
    fresh: LlmMessage[],
    cwd: string,
  ): Promise<{ prompt: string; image?: string }> {
    const parts: string[] = [
      `FlowM canvas mode is active. Read ${this.guidePath} before drawing.`,
      `Project root: ${cwd}`,
    ]
    let image: string | undefined
    for (const m of fresh) {
      if (m.role === 'user') {
        parts.push(m.content)
        if (m.image) image = projectPath(cwd, await writeDesign(cwd, m.image))
      } else if (m.role === 'tool') {
        parts.push(`Result of the previous operations: ${m.content}`)
      }
    }
    if (image) parts.push(`The rendered canvas image is attached and also saved at ${image}.`)
    return { prompt: parts.join('\n\n'), image }
  }
}

function projectPath(cwd: string, rel: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('\\\\') || rel.startsWith('/')) return rel
  return `${cwd.replace(/[\\/]+$/, '')}${cwd.includes('\\') ? '\\' : '/'}${rel.replace(/^[\\/]+/, '')}`
}

function parseStructured(raw: string | null): unknown {
  if (!raw) return null
  const text = raw.trim()
  for (const candidate of [text, stripFence(text), extractObject(text)]) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next representation
    }
  }
  return null
}

function stripFence(text: string): string | null {
  const m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return m?.[1] ?? null
}

function extractObject(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : null
}
