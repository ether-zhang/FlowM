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
const FLOWM_CANVAS_GUIDE = `# FlowM 画布模式（本文件即开关，Claude Code 自动加载、跨轮缓存）

你是 FlowM 的画布助手。每轮你会收到当前画布（带 [n] 标号的形状列表 + 一张渲染图，选中的部分有标注）和用户的话；需要时直接用 Read / Grep 读本工程代码理解后再画（不要派生子 agent）。

## 输出（structured output，不是普通聊天）
- 自己判断要不要动画布：只是问答 → operations 留空数组、答案写进 reply。
- 要画 / 改 / 排 → 动作放进 operations，规范化。每轮会看到上一批结果；已完成、无新增/修正 → 返回空 operations（别重画）。
- reply 一句话以内，别叙述读了哪些文件、别兜售“我可以再画一块”。画布是交付物，让图说话。

## 操作词汇（operations 里每一项）
- create_geo  {op,shape:rectangle|ellipse|diamond,x,y,w?,h?,text?,ref?}
- create_text {op,x,y,text,ref?}
- connect_shapes {op,from,to,text?}    from/to = 你给新形状的 ref，或画布列表里已有形状的 id
- move_shape / update_text / delete_shape  {op,id,…}   改已有形状（按其 id）
- declare_structure {op,relations:[…]}   声明区域结构、让框架精排（见下）
坐标：x 向右、y 向下。每个新形状给一个短 ref；连线用 ref。

## 布局：自由优先，别套模板
- 用足二维空间。结构 / 架构 / 数据关系 / 概念图 → 网状、分组、多列自由摆放，大胆用交叉连线，按真实关系布局，不要硬塞成单列流程图。
- 只有真正线性的流程（步骤序列、判定分支）才走自上而下的单列主轴。
- 一张画布可以混：一块流程、一块结构。按区域决定，不是整张一个模式。
- 箭头只用于真实的“流向 / 依赖 / 顺序”；纯并列、包含关系用空间位置表达，不强加箭头。

## declare_structure（可选，给框架兜底精排）
画了规整结构（连成链的流程、网格、嵌套）就声明，框架据此拉直 / 匀距 / 防重叠：
- flow {nodes:[id…],dir:down|right}   align {nodes,axis:col|row,at:min|center|max}
- grid {nodes,cols}   contain {parent,children}   nonOverlap {nodes}   freeze {nodes}
按形状 id（创建时返回、列表里显示）。自由网状摆放的部分就别声明，框架不动它。

## marks
渲染图里每个节点左上角橙色 [n]，和列表 [n] 对应——只是指认形状的把手（“[3] 和 [5] 重叠”），不是顺序 / 流向。复核轮：看图修明显错位（move_shape）即可，没问题就返回空 operations，别重读代码。`

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

  constructor(getCwd: () => string) {
    this.getCwd = getCwd
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
      undefined,
      schema,
      this.session ?? undefined,
      // No subagents on the canvas engine: direct Read/Grep reads code fine for a diagram, while a
      // Task subagent inflates cost and (suspected) perturbs the result stream so the structured
      // ops fail to land — the "drew nothing" failure. Also kills the review-turn essay.
      ['Task'],
    )

    const result = toTurn(structured, this.turn)
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
        parts.push(`【上一步执行结果】${m.content}`)
      }
    }
    let prompt = parts.join('\n\n')
    if (image) {
      const path = await writeDesign(cwd, image)
      prompt += `\n\n（本轮画布渲染图已存到 ${path}，先 Read 它看实际布局与选中标注。）`
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
