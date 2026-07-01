import type { LlmAdapter, RunTurnParams, TurnCallbacks } from './adapter'
import type { LlmMessage, LlmTurn, LlmToolCall } from './types'
import type { ToolDef } from '../protocol'
import { claudeRun, writeDesign, writeGuide } from '../engine/claudeCode'
import { interpretClaudeLine, extractStructured, extractSessionId } from '../engine/claudeStream'

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
 *  2. A Claude-tailored guide (FLOWM_CANVAS_GUIDE — its own contract, layout-freedom-first) is
 *     written ONCE to `<cwd>/CLAUDE.local.md`. It is DECOUPLED from Conversation's Poe `SYSTEM`
 *     (`params.system` is intentionally ignored): the Poe prompt over-constrains Claude into
 *     linear vertical-spine flowcharts, flattening the richer mesh/structure diagrams it can do.
 *     Claude Code auto-loads the file every invocation and prompt-caches it across `--resume`,
 *     so the guide is the project "switch", never re-sent in a turn's prompt.
 *  3. History is NOT replayed: each `runTurn` sends only the messages new since the last one
 *     (plus `--resume`), because Claude Code's own session JSON already holds the conversation.
 *
 * The `Task` subagent is disallowed: direct Read/Grep reads code fine for a diagram, while a
 * subagent inflates cost and (suspected) perturbs the result stream so the ops fail to land.
 * Desktop (Tauri) only — it spawns the user's local `claude`.
 */

/**
 * The whole FlowM guide written to CLAUDE.local.md (Claude Code auto-loads + caches it). It is
 * Claude's OWN contract — deliberately NOT the Poe SYSTEM, whose vertical-spine flowchart rules
 * herd Claude into single-column diagrams. Keeps the op vocabulary + marks + the judge-or-draw
 * rule, but its layout philosophy is freedom-first (mesh/grouped/multi-column), with
 * declare_structure as the framework's tidy-up guardrail.
 */
const FLOWM_CANVAS_GUIDE = `# FlowM canvas mode (this file is the switch — Claude Code auto-loads + caches it)

You are FlowM's canvas assistant. Each turn you get the current canvas (a shape list tagged with [n] marks + a rendered image; the selection is marked) and the user's message. When you need to, read this project's code directly with Read / Grep before drawing (do NOT spawn a subagent).

## Output (structured output, not plain chat)
- Decide whether to touch the canvas: a plain question → leave operations empty, put the answer in reply.
- To draw / edit / arrange → put the actions in operations, normalized. Each turn you see the previous batch's results; when it is done with nothing to add or fix → return empty operations (don't redraw).
- Keep reply to one sentence; don't narrate which files you read, don't pitch "I can draw another part". The canvas is the deliverable — let it speak.
- Write shape / node LABELS in the USER'S language (e.g. Chinese if they wrote Chinese). These instructions are English; the diagram is not.

## Operation vocabulary (each item of operations)
- create_geo  {op,shape:rectangle|ellipse|diamond,x?,y?,w?,h?,text?,ref?}
- create_text {op,x?,y?,text,ref?}
- connect_shapes {op,from,to,text?}    from/to = a ref you gave a new shape, or the id of an existing shape in the canvas list
- move_shape / update_text / delete_shape  {op,id,…}   edit an existing shape (by its id)
- declare_structure {op,relations:[…]}   declare a region's structure so the framework lays it out (see below)
Coordinates: x grows right, y grows down. Give each new shape a short ref; connect with refs.

## Content first: draw fully and concretely
- After you understand the code, synthesize and draw it from both the macro-architecture layer and the call chain / data flow layer. While using real class / function / data-structure names, also explain each node’s specific role within the macro structure where appropriate—especially when tied closely to the actual code, provide more detailed explanation. The number of nodes is not the key; what matters is strictly following the user’s instruction and clearly expressing the structure. For relationships with ordering, present them in a top-down reading order, but introduce side branches when necessary.
- Dynamically decide whether to draw a call chain or a macro-structure diagram; if uncertain, draw both and clearly establish the correspondence between them.
- Don't spend the node budget on decoration (rows of placeholder cells) — spend it on structural depth.

## Layout: freedom first, no fixed template
- Use the 2D space fully. Structure / architecture / data-relationship / concept diagrams → mesh, grouped, multi-column free placement; use crossing connectors freely; lay out by real relationships, don't cram into a single column.
- Only a genuinely linear process (a step sequence, decision branches) runs down a single vertical spine.
- One canvas can mix both: a process region + a structure region. Decide per region, not one mode for the whole canvas.
- Use arrows only for a real flow / dependency / order; pure side-by-side or containment is shown by position, not forced arrows.

## Coordinates: omit them for structure — the framework lays it out
- For flowchart / structured / connected nodes — which is almost EVERY node in a "draw how X works" diagram — **DO NOT include x/y or w/h at all.** Emit only shape + text + ref, connect them, and declare_structure; the framework lays the whole region out from its connections (clean layered layout), sizes boxes to text, evens spacing, de-overlaps, routes arrows. Lean on it; put your effort into CONTENT, not pixels.
  A node you SHOULD emit (note: no x/y/w/h):
  {"op":"create_geo","shape":"rectangle","text":"Scheduler.schedule()","ref":"sched"}
- Give x/y ONLY for a deliberate spatial placement: a free-form / non-flowchart unit, or editing relative to an existing shape ("put this to the right of [3]").
- declare_structure does double duty — it lays a region out AND keeps its nodes together. So declare each connected region (flow / grid / nesting) whose nodes you left coordinate-less.

## declare_structure (optional, the framework's tidy-up)
Declare any regular structure you drew (a chain of connected nodes, a grid, a nesting); the framework straightens / evens spacing / de-overlaps from it:
- flow {nodes:[id…],dir:down|right}   align {nodes,axis:col|row,at:min|center|max}
- grid {nodes,cols}   contain {parent,children}   nonOverlap {nodes}   freeze {nodes}
Reference shapes by id (returned on create, shown in the list). Don't declare free-form / mesh placement — the framework leaves it untouched.

## marks
In the rendered image each node has an orange [n] at its top-left, matching [n] in the list — just a handle to point at a shape ("[3] overlaps [5]"), not an order / flow. Review turn: fix clear misplacements with move_shape; if it looks right, return empty operations and don't re-read the code.`

export class ClaudeAdapter implements LlmAdapter {
  private getCwd: () => string
  /** Claude Code session for this conversation; captured on the first call, `--resume`d after. */
  private session: string | null = null
  /** How many of Conversation's accumulated messages we've already forwarded. We send only the
   *  tail each turn (+ `--resume`); Claude's own session holds everything before it. */
  private sent = 0
  /** Bump per turn so tool-call ids are unique across the within-turn build loop. */
  private turn = 0
  /** The cwd whose CLAUDE.local.md we've already written, so we re-write if the dir changes. */
  private guideCwd: string | null = null
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

    // (1) The guide is the project switch — write FlowM's own Claude guide to CLAUDE.local.md
    //     once per cwd (params.system, the Poe SYSTEM, is intentionally ignored — see class doc).
    if (this.guideCwd !== cwd) {
      await writeGuide(cwd, FLOWM_CANVAS_GUIDE)
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
    // onRequest). It's the short per-turn delta — system + history live in CLAUDE.local.md + the
    // resumed session, NOT in this prompt.
    cb.onDebug?.(
      `▶ 实际发给 Claude · 第 ${this.turn} 轮\n` +
        `system: 不在请求里 → CLAUDE.local.md（已缓存）\n` +
        `resume: ${this.session ?? '(新会话)'} · disallowedTools: Task · json-schema: { reply, operations[] }\n` +
        `本轮增量（${fresh.length} 条 / ${prompt.length} 字）:\n${prompt}`,
    )

    let structured: unknown = null
    await claudeRun(
      prompt,
      cwd,
      (e) => {
        if (e.kind !== 'stdout') return
        // Tool activity (Read/Grep/…) → the system-note channel (the chat's yellow hints), so the
        // user sees Claude working WITHOUT it cluttering the assistant bubble. The reply itself is
        // streamed to the bubble after the run (it comes from the structured output, not here).
        for (const item of interpretClaudeLine(e.line)) if (item.kind === 'system') cb.onSystem?.(item.text)
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
    )

    const result = toTurn(structured, this.turn)
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
  const toolCalls: LlmToolCall[] = []
  ops.forEach((op, i) => {
    if (op && typeof op === 'object' && typeof (op as { op?: unknown }).op === 'string') {
      const { op: name, ...args } = op as { op: string } & Record<string, unknown>
      toolCalls.push({ id: `claude-${turn}-${i}`, name, args })
    }
  })
  return { text, toolCalls }
}
