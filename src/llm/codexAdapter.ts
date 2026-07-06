import type { LlmAdapter, RunTurnParams, TurnCallbacks } from './adapter'
import type { LlmMessage, LlmToolCall, LlmTurn } from './types'
import type { ToolDef } from '../protocol'
import { codexRun, writeCodexCanvasGuide } from '../engine/codexCli'
import { createCodexStderrFilter, interpretCodexLine, extractCodexThreadId } from '../engine/codexStream'
import { writeDesign } from '../engine/claudeCode'
import { FLOWM_CANVAS_SYSTEM_PROMPT } from './canvasPrompt'

export class CodexAdapter implements LlmAdapter {
  private getCwd: () => string
  private getBin: () => string
  private session: string | null = null
  private sent = 0
  private turn = 0
  private guideCwd: string | null = null
  private guidePath = '.flowm/codex-canvas.md'

  constructor(getCwd: () => string, getBin: () => string, initialSession: string | null = null) {
    this.getCwd = getCwd
    this.getBin = getBin
    this.session = initialSession
  }

  get sessionId(): string | null {
    return this.session
  }

  async runTurn(params: RunTurnParams, cb: TurnCallbacks): Promise<LlmTurn> {
    const cwd = this.getCwd().trim()
    if (!cwd) throw new Error('请先打开工程')

    if (this.guideCwd !== cwd) {
      this.guidePath = await writeCodexCanvasGuide(cwd, FLOWM_CANVAS_SYSTEM_PROMPT)
      this.guideCwd = cwd
    }

    const fresh = params.messages.slice(this.sent)
    this.sent = params.messages.length
    const hasUser = fresh.some((m) => m.role === 'user')
    const hasError = fresh.some((m) => m.role === 'tool' && /"ok"\s*:\s*false|^error/i.test(m.content))
    if (!hasUser && !hasError) return { text: '', toolCalls: [] }

    const { prompt, image } = await this.composeDelta(fresh, cwd)
    const schema = buildCodexOpsSchema(params.tools)
    this.turn++

    cb.onDebug?.(
      `▶ 实际发给 Codex · 第 ${this.turn} 轮\n` +
        `resume: ${this.session ?? '(新会话)'} · output-schema: { reply, operations[] }\n` +
        `system: invocation-scoped guide -> ${this.guidePath}\n` +
        `cwd: ${cwd} · repo policy: read-only · sandbox: platform default · image: ${image ?? '(无)'}\n` +
        `本轮增量：${fresh.length} 条 / ${prompt.length} 字符\n${prompt}`,
    )

    let prose = ''
    const stderrFilter = createCodexStderrFilter()
    const last = await codexRun(
      prompt,
      cwd,
      (e) => {
        if (e.kind !== 'stdout') {
          if (e.kind === 'stderr') {
            const line = stderrFilter(e.line)
            if (line) cb.onSystem?.('⚠ ' + line)
          }
          return
        }
        const sid = extractCodexThreadId(e.line)
        if (!this.session && sid) this.session = sid
        for (const item of interpretCodexLine(e.line)) {
          if (item.kind === 'system') cb.onSystem?.(item.text)
          else prose += item.text
        }
      },
      {
        bin: this.getBin().trim() || undefined,
        outputSchema: schema,
        resume: this.session ?? undefined,
        image,
        readOnly: true,
      },
    )
    const structured = parseStructured(last)
    const result = toTurn(structured, this.turn)
    if (!result.text && result.toolCalls.length === 0 && prose.trim()) result.text = prose.trim()

    if (cb.onDebug) {
      const ops = Array.isArray((structured as { operations?: unknown })?.operations) ? ((structured as { operations: unknown[] }).operations) : []
      const geos = ops.filter((o) => !!o && typeof o === 'object' && (o as { op?: unknown }).op === 'create_geo') as { x?: unknown; y?: unknown }[]
      const withXY = geos.filter((o) => o.x != null || o.y != null).length
      cb.onDebug(
        `◀ Codex 原始返回 · 第 ${this.turn} 轮 · 操作 ${ops.length}（create_geo ${geos.length}，其中带坐标 ${withXY}）\n` +
          (last ?? '(无最终消息)'),
      )
    }
    if (structured == null) console.warn('[CodexAdapter] no structured output captured - nothing to apply this turn')
    console.info(
      `[CodexAdapter] turn ${this.turn}: sent ${prompt.length} chars / ${fresh.length} msgs · captured ${result.toolCalls.length} ops · session ${this.session ?? '(new)'}`,
    )
    if (result.text) cb.onText(result.text)
    return result
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

function toTurn(structured: unknown, turn: number): LlmTurn {
  const obj = (structured ?? {}) as { reply?: unknown; operations?: unknown }
  const text = typeof obj.reply === 'string' ? obj.reply : ''
  const ops = Array.isArray(obj.operations) ? obj.operations : []
  const toolCalls: LlmToolCall[] = []
  ops.forEach((op, i) => {
    if (op && typeof op === 'object' && typeof (op as { op?: unknown }).op === 'string') {
      const { op: name, ...args } = stripNulls(op) as { op: string } & Record<string, unknown>
      toolCalls.push({ id: `codex-${turn}-${i}`, name, args })
    }
  })
  return { text, toolCalls }
}

/**
 * Codex uses OpenAI Structured Outputs, whose JSON Schema subset requires every object to set
 * `additionalProperties:false`. It also behaves best when all properties are required, so optional
 * operation fields are represented as nullable and stripped before FlowM validates the op.
 */
export function buildCodexOpsSchema(tools: ToolDef[]): Record<string, unknown> {
  const toolNames = tools.map((t) => t.name)
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      reply: { type: 'string', description: 'User-facing answer. Use an empty string if there is nothing to say.' },
      operations: {
        type: 'array',
        description: 'Canvas operations. Use [] for answer-only or no-op turns.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', enum: toolNames },
            shape: { type: ['string', 'null'], enum: ['rectangle', 'ellipse', 'diamond', 'triangle', null] },
            x: { type: ['number', 'null'] },
            y: { type: ['number', 'null'] },
            w: { type: ['number', 'null'] },
            h: { type: ['number', 'null'] },
            text: { type: ['string', 'null'] },
            ref: { type: ['string', 'null'] },
            id: { type: ['string', 'null'] },
            ids: { type: ['array', 'null'], items: { type: 'string' } },
            prefer: { type: ['string', 'null'], enum: ['right', 'below', 'left', 'above', 'nearest', null] },
            anchorId: { type: ['string', 'null'] },
            margin: { type: ['number', 'null'] },
            from: { type: ['string', 'null'] },
            to: { type: ['string', 'null'] },
            relations: {
              type: ['array', 'null'],
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: ['string', 'null'], enum: ['flow', 'align', 'grid', 'contain', 'nonOverlap', 'freeze', null] },
                  nodes: { type: ['array', 'null'], items: { type: 'string' } },
                  parent: { type: ['string', 'null'] },
                  children: { type: ['array', 'null'], items: { type: 'string' } },
                  dir: { type: ['string', 'null'], enum: ['down', 'right', null] },
                  axis: { type: ['string', 'null'], enum: ['col', 'row', null] },
                  at: { type: ['string', 'null'], enum: ['min', 'center', 'max', null] },
                  cols: { type: ['integer', 'null'] },
                  gap: { type: ['number', 'null'] },
                },
                required: ['kind', 'nodes', 'parent', 'children', 'dir', 'axis', 'at', 'cols', 'gap'],
              },
            },
          },
          required: ['op', 'shape', 'x', 'y', 'w', 'h', 'text', 'ref', 'id', 'ids', 'prefer', 'anchorId', 'margin', 'from', 'to', 'relations'],
        },
      },
    },
    required: ['reply', 'operations'],
  }
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls).filter((v) => v !== null)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (v === null) continue
    out[k] = stripNulls(v)
  }
  return out
}
