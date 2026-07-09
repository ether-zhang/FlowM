import type { LlmAdapter, RunTurnParams, TurnCallbacks } from './adapter'
import type { LlmMessage, LlmTurn, LlmToolCall } from './types'
import type { ToolDef } from '../protocol'
import { claudeRun, writeClaudeCanvasGuide, writeDesign } from '../engine/claudeCode'
import { interpretClaudeLine, extractStructured, extractSessionId } from '../engine/claudeStream'
import { FLOWM_CANVAS_SYSTEM_PROMPT } from './canvasPrompt'
import { normalizeLlmQuestion } from './questions'

/**
 * Claude Code as an LlmAdapter — the SAME canvas pipeline (Conversation: serialize + marks →
 * operations → apply → review), just with the user's local Claude Code driving the model
 * instead of Poe. Nothing in Conversation / protocol / canvas changes; this is the only seam.
 *
 * Three things let an agentic, repo-reading Claude fit Conversation's single-turn `runTurn`:
 *  1. The model's "tool calls" come from a FORCED structured final output: the canvas tools
 *     (`params.tools`) become a `--json-schema` of `{reply, operations[]}`. Claude explores the
 *     repo with its native Read/Grep, then emits the operations; we map them to LlmToolCall[]
 *     and Conversation validates each with its existing parseOp / parseStructure.
 *  2. The shared FlowM canvas guide is written under `<cwd>/.flowm/claude-canvas.md`, then
 *     referenced by a short `--append-system-prompt` for this FlowM call path.
 *  3. History is NOT replayed: each `runTurn` sends only the messages new since the last one
 *     (plus `--resume`), because Claude Code's own session JSON already holds the conversation.
 *
 * The `Task` subagent is disallowed: direct Read/Grep reads code fine for a diagram, while a
 * subagent inflates cost and (suspected) perturbs the result stream so the ops fail to land.
 * Desktop (Tauri) only — it spawns the user's local `claude`.
 */

export class ClaudeAdapter implements LlmAdapter {
  private getCwd: () => string
  /** Claude Code session for this conversation; captured on the first call, `--resume`d after. */
  private session: string | null = null
  /** How many of Conversation's accumulated messages we've already forwarded. We send only the
   *  tail each turn (+ `--resume`); Claude's own session holds everything before it. */
  private sent = 0
  /** Bump per turn so tool-call ids are unique across the within-turn build loop. */
  private turn = 0
  private guideCwd: string | null = null
  private guidePath = '.flowm/claude-canvas.md'
  /** Path to the `claude` executable (empty → let the backend resolve `claude` via PATH). */
  private getBin: () => string

  /** `initialSession` seeds `--resume` when a persisted conversation is reopened (e.g. after a
   *  restart): the adapter resumes Claude's stored session and sends only the new delta, so the
   *  history need not be replayed. Omit for a brand-new conversation. */
  constructor(getCwd: () => string, getBin: () => string, initialSession: string | null = null) {
    this.getCwd = getCwd
    this.getBin = getBin
    this.session = initialSession
  }

  /** The Claude Code session id captured for this conversation (the `--resume` handle), or null
   *  before the first turn. The workspace persists it per conversation so a reopen can resume. */
  get sessionId(): string | null {
    return this.session
  }

  async runTurn(params: RunTurnParams, cb: TurnCallbacks): Promise<LlmTurn> {
    const cwd = this.getCwd().trim()
    if (!cwd) throw new Error('请先填写工程目录')

    if (this.guideCwd !== cwd) {
      this.guidePath = await writeClaudeCanvasGuide(cwd, FLOWM_CANVAS_SYSTEM_PROMPT)
      this.guideCwd = cwd
    }

    // (3) Only what's new since the last runTurn; Claude's session has the rest.
    const fresh = params.messages.slice(this.sent)
    this.sent = params.messages.length

    // The build loop's "are you done?" round arrives as tool-results only (no new user message).
    // If every op applied cleanly there's nothing for Claude to add — end the loop WITHOUT a
    // (slow) Claude call. Errors are NOT short-circuited: send them so Claude can self-correct.
    const hasUser = fresh.some((m) => m.role === 'user')
    const hasError = fresh.some((m) => m.role === 'tool' && /"ok"\s*:\s*false|^error/i.test(m.content))
    if (!hasUser && !hasError) return { text: '', toolCalls: [] }

    const prompt = await this.composeDelta(fresh, cwd)
    const schema = buildOpsSchema(params.tools)
    this.turn++

    // Debug: report the REAL outgoing request (the Claude engine suppresses Conversation's logical
    // onRequest). It's the short per-turn delta; the guide lives in .flowm and is referenced by
    // a short invocation-scoped system prompt. History lives in the resumed Claude Code session.
    cb.onDebug?.(
      `▶ 实际发给 Claude · 第 ${this.turn} 轮\n` +
        `system: --append-system-prompt -> ${this.guidePath}\n` +
        `resume: ${this.session ?? '(新会话)'} · disallowedTools: Task · json-schema: { reply, operations[] }\n` +
        `本轮增量（${fresh.length} 条 / ${prompt.length} 字）:\n${prompt}`,
    )

    let structured: unknown = null
    // Accumulate the model's natural-language prose across the turn. Normally the bubble shows only
    // the structured `reply` (so drawing turns don't dump working-notes into the chat). But on a
    // pure ANSWER turn the model may put its explanation in prose and leave `reply` empty — we fall
    // back to this so that answer isn't dropped (see below).
    let prose = ''
    await claudeRun(
      prompt,
      cwd,
      (e) => {
        if (e.kind !== 'stdout') return
        // Tool activity (Read/Grep/…) → the system-note channel (the chat's yellow hints), so the
        // user sees Claude working WITHOUT it cluttering the assistant bubble. Prose text is kept
        // as the answer-mode fallback; the reply itself comes from the structured output after the run.
        for (const item of interpretClaudeLine(e.line)) {
          if (item.kind === 'system') cb.onSystem?.(item.text)
          else if (item.kind === 'text') prose += item.text
        }
        if (!this.session) {
          const sid = extractSessionId(e.line)
          if (sid) this.session = sid
        }
        const s = extractStructured(e.line)
        if (s != null) structured = s
      },
      this.getBin().trim() || undefined,
      schema,
      this.session ?? undefined,
      // No subagents on the canvas engine: direct Read/Grep reads code fine for a diagram, while a
      // Task subagent inflates cost and (suspected) perturbs the result stream so the structured
      // ops fail to land — the "drew nothing" failure. Also kills the review-turn essay.
      ['Task'],
      `FlowM canvas mode is active. Read ${this.guidePath} before drawing.`,
    )

    const result = toTurn(structured, this.turn)
    // Answer-mode fallback: the model answered in PROSE and left the structured reply empty, with no
    // operations — surface the prose so the answer isn't swallowed. Guarded on no operations, so a
    // drawing turn's working-notes prose still never reaches the bubble.
    if (!result.question && !result.text && result.toolCalls.length === 0 && prose.trim()) result.text = prose.trim()
    // Debug: the model's RAW structured output — so the panel shows EXACTLY what Claude returned
    // (notably: do its create_geo ops carry x/y, or did it leave layout to the framework?), not
    // just the post-apply canvas (whose list always has coordinates). Coordinate count up front.
    if (cb.onDebug) {
      const ops = Array.isArray((structured as { operations?: unknown })?.operations) ? ((structured as { operations: unknown[] }).operations) : []
      const geos = ops.filter((o) => !!o && typeof o === 'object' && (o as { op?: unknown }).op === 'create_geo') as { x?: unknown; y?: unknown }[]
      const withXY = geos.filter((o) => o.x != null || o.y != null).length
      cb.onDebug(
        `◀ Claude 原始返回 · 第 ${this.turn} 轮 · 操作 ${ops.length}（create_geo ${geos.length}，其中带坐标 ${withXY}）\n` +
          JSON.stringify(structured ?? null, null, 2),
      )
    }
    // Observability: a missing structured_output means the canvas silently stays empty — log it
    // loudly so a recurrence is diagnosable (capture vs apply) straight from the devtools console.
    if (structured == null) console.warn('[ClaudeAdapter] no structured_output captured — nothing to apply this turn')
    console.info(
      `[ClaudeAdapter] turn ${this.turn}: sent ${prompt.length} chars / ${fresh.length} msgs · captured ${result.toolCalls.length} ops · session ${this.session ?? '(new)'}`,
    )
    // The model's short reply goes to the bubble; tool progress already showed as system hints.
    if (result.text) cb.onText(result.text)
    return result
  }

  /** Turn the new (non-assistant) messages into one prompt; the latest image is written to
   *  design.png and referenced by path. Assistant messages are Claude's OWN prior output —
   *  already in its session, so they're never replayed. */
  private async composeDelta(fresh: LlmMessage[], cwd: string): Promise<string> {
    const parts: string[] = []
    let image: string | undefined
    for (const m of fresh) {
      if (m.role === 'user') {
        parts.push(m.content)
        if (m.image) image = m.image
      } else if (m.role === 'tool') {
        parts.push(`Result of the previous operations: ${m.content}`)
      }
    }
    let prompt = parts.join('\n\n')
    if (image) {
      const path = await writeDesign(cwd, image)
      prompt += `\n\n(This turn's rendered canvas is saved at ${path} — Read it to see the actual layout and the selection marks.)`
    }
    return prompt
  }
}

/**
 * Build the forced-output JSON Schema from the canvas tools: `{reply?, operations[]}`. The
 * operations item is ONE permissive object (every tool field, only `op` required) — the same
 * "list all fields, validate per-op downstream" trick the tools themselves use; Conversation's
 * parseOp / parseStructure then validate each op and report errors back for self-correction.
 * `operations` is required but may be empty, so the model can judge: empty = just answering /
 * nothing to add.
 */
export function buildOpsSchema(tools: ToolDef[]): Record<string, unknown> {
  const props: Record<string, unknown> = {
    op: { type: 'string', enum: tools.map((t) => t.name), description: '操作类型' },
  }
  for (const t of tools) {
    const tprops = (t.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    for (const [k, v] of Object.entries(tprops)) if (!(k in props)) props[k] = v
  }
  return {
    type: 'object',
    properties: {
      reply: { type: 'string', description: '给用户的简短文字（可选）；只问答时把答案放这里、operations 留空。' },
      question: {
        type: 'object',
        description: 'Set this only when you need the user to confirm or choose before continuing. If set, keep operations empty.',
        properties: {
          prompt: { type: 'string', description: 'The concise yes/no/other question shown to the user.' },
        },
        required: ['prompt'],
      },
      operations: {
        type: 'array',
        description: '本轮对画布的动作，规范化；无改动时给空数组。',
        items: { type: 'object', properties: props, required: ['op'] },
      },
    },
    required: ['operations'],
  }
}

/**
 * Map the structured `{reply, operations}` into a provider-neutral turn. Each operation becomes
 * a tool call (name = its `op`); Conversation routes create/connect/… to parseOp and
 * declare_structure to parseStructure, exactly as it does for a Poe tool call.
 */
function toTurn(structured: unknown, turn: number): LlmTurn {
  const obj = (structured ?? {}) as { reply?: unknown; operations?: unknown }
  const text = typeof obj.reply === 'string' ? obj.reply : ''
  const ops = Array.isArray(obj.operations) ? obj.operations : []
  const question = normalizeLlmQuestion((obj as { question?: unknown }).question)
  const toolCalls: LlmToolCall[] = []
  ops.forEach((op, i) => {
    if (op && typeof op === 'object' && typeof (op as { op?: unknown }).op === 'string') {
      const { op: name, ...args } = op as { op: string } & Record<string, unknown>
      toolCalls.push({ id: `claude-${turn}-${i}`, name, args })
    }
  })
  return question ? { text, toolCalls, question } : { text, toolCalls }
}
