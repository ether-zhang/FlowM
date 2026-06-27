import {
  type CanvasPort,
  type CanvasShape,
  type CanvasOp,
  type LayoutScope,
  type StructureRelation,
  canvasTools,
  declareStructureTool,
  formatCanvas,
  parseOp,
  parseStructure,
  resolveScope,
  toolCallToOp,
} from '../protocol'
import type { LlmAdapter, RunTurnParams } from './adapter'
import type { LlmMessage, LlmToolCall } from './types'

const SYSTEM = `You are FlowM's canvas assistant. You collaborate with the user on an infinite 2D canvas — it may hold structured flowcharts/diagrams OR free-form notes, sketches and hand-drawn strokes (like a whiteboard / 无边记 board).

- Before each user message you are given the current canvas (selection, or whole canvas) two ways: (1) a list of shapes with their ids, types, page coordinates (top-left), sizes and text, AND (2) an IMAGE of that same selection/canvas. Use the image to see the actual layout, hand-drawn strokes, colors and visual intent that the shape list can't fully convey.
- Each NODE (box / ellipse / diamond / standalone text — NOT arrows) is tagged with a number in an orange box at its top-left corner in the IMAGE, and the same number prefixes its line as \`[n]\` in the shape list. These are just arbitrary handles for pointing at a shape — e.g. "the box marked [3] overlaps [5]" or "[2] contains [4]". They are NOT an order, priority, or flow direction (the flow is shown by the arrows), and have nothing to do with any numbering inside the shapes' own text. They are an overlay for your reference only — not real shapes, and the numbering may differ from turn to turn.
- Judge intent from the user's request AND the image, then pick the right output:
  - a STRUCTURED flowchart — rectangles=steps, diamonds=decisions, ellipses=start/end, connected by arrows in flow order — when they want a process/diagram;
  - a FREE-FORM arrangement — shapes and text laid out spatially to express or annotate an idea, no rigid flow or arrows — when they're sketching, brainstorming, or organizing notes.
  Don't force a flowchart when free arrangement fits, and vice versa.
- You can both answer in words AND modify the canvas by calling the provided tools. When the user asks you to draw, arrange, or edit, USE THE TOOLS.
- Coordinates are page space: x grows right, y grows down. Default shapes are ~120 wide × 80 tall.
- Space shapes GENEROUSLY so connecting arrows are clearly visible and shapes never overlap: leave at least ~100px of empty gap between adjacent shapes. In practice, for a top-to-bottom flowchart step each node ~200px down (y += 200); for a left-to-right layout step ~260px across (x += 260). Diamonds and shapes with long labels are bigger — give them extra room.
- To connect shapes, give each new shape a short \`ref\` and pass those refs (or existing shape ids from the canvas context) to connect_shapes. You can create and connect in the same response, or connect shapes from earlier turns by their id — arrows bind to their endpoints and follow them when moved either way.
- For flowcharts: rectangle = step, diamond = decision, ellipse = start/end. Connect with arrows in flow order.
- Lay flowcharts on a VERTICAL SPINE: the main path (start → steps → the success/"是" branch of each decision → end) runs straight down a single shared column (same x, increasing y), with the terminal/end node placed directly BELOW the last node — not off to one side. Send only the SECONDARY exits sideways: a decision's "否"/failure branch and loop-backs leave from the side and return to the spine, so the main flow reads as one clean top-to-bottom line.
- After you finish drawing you'll be shown the rendered result ONCE. Use that review to call \`declare_structure\` for any region the framework should lay out precisely (flow / align / grid / contain), and \`move_shape\` to fix clear misplacements; if it already looks right, just reply without tools.
- Keep prose brief; let the canvas do the talking.`

const MAX_ITERATIONS = 8

/** Tools the model may call: the canvas ops plus the review-step structure declaration. */
const ALL_TOOLS = [...canvasTools, declareStructureTool]

const REVIEW_PROMPT = `Here is your drawing as it actually rendered, each node tagged with its mark number. Review it ONCE:
- If a region should be laid out precisely by the framework, call declare_structure — e.g. flow for a chain down a column, align to share a row/column, grid for a matrix, contain for nesting. Reference nodes by their [n] marks.
- If something is clearly misplaced (e.g. a card flung far off to one side), fix it with move_shape.
- If it already looks right, just reply briefly with NO tool calls.`

interface OpCall {
  id: string
  op?: CanvasOp
  error?: string
}
interface DeclareCall {
  id: string
  args: Record<string, unknown>
}

/** Split a turn's tool calls into canvas ops (validated) and structure declarations. */
function splitTools(toolCalls: LlmToolCall[]): { opCalls: OpCall[]; declareCalls: DeclareCall[] } {
  const opCalls: OpCall[] = []
  const declareCalls: DeclareCall[] = []
  for (const tc of toolCalls) {
    if (tc.name === 'declare_structure') {
      declareCalls.push({ id: tc.id, args: tc.args })
      continue
    }
    try {
      opCalls.push({ id: tc.id, op: parseOp(toolCallToOp(tc.name, tc.args)) })
    } catch (e) {
      opCalls.push({ id: tc.id, error: (e as Error).message })
    }
  }
  return { opCalls, declareCalls }
}

/** One set-of-mark number per NODE (arrows aren't marked), in snapshot order. */
function nodeMarks(shapes: CanvasShape[]): Map<string, number> {
  let n = 0
  const m = new Map<string, number>()
  for (const s of shapes) if (s.type !== 'arrow') m.set(s.id, ++n)
  return m
}

export interface SendCallbacks {
  onText(text: string): void
  /** Fired after a batch of canvas ops is applied, with a short human summary. */
  onToolsApplied(summary: string): void
  /**
   * Debug hook: fired right before each model call with the exact request
   * (system + message history + tools) for that loop iteration. `iteration` is
   * 0-based. Used by the UI's debug mode to show what was sent to the model.
   */
  onRequest?(params: RunTurnParams, iteration: number): void
}

/** Holds the provider-neutral message history and runs the tool-use loop for one user turn. */
export class Conversation {
  private history: LlmMessage[] = []
  private adapter: LlmAdapter

  constructor(adapter: LlmAdapter) {
    this.adapter = adapter
  }

  reset(messages: LlmMessage[] = []) {
    this.history = messages
  }

  get messages(): LlmMessage[] {
    return this.history
  }

  async send(userText: string, port: CanvasPort, cb: SendCallbacks): Promise<void> {
    const shapes = port.snapshot('selection')
    const marks = nodeMarks(shapes)
    const context = formatCanvas(shapes, marks)
    const image = await port.exportImage('selection', marks)

    // Keep only the newest turn's image: vision tokens are costly and stale
    // snapshots add little once the canvas has moved on.
    for (const m of this.history) if (m.role === 'user') delete m.image

    this.history.push({
      role: 'user',
      content: `Current canvas:\n${context}\n\n---\n${userText}`,
      ...(image ? { image } : {}),
    })

    const mutated = await this.runBuildLoop(port, cb)
    // One visual-review round: show the rendered result so the model can declare the
    // intended structure (laid out precisely by the framework) and fix any misplacement.
    if (mutated) await this.reviewGate(port, cb)
  }

  /** Build phase: let the model create/connect/move until it stops calling tools.
   *  Returns whether any canvas mutation was actually applied. */
  private async runBuildLoop(port: CanvasPort, cb: SendCallbacks): Promise<boolean> {
    let mutated = false
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const params: RunTurnParams = { system: SYSTEM, messages: this.history, tools: ALL_TOOLS }
      cb.onRequest?.(params, i)
      const turn = await this.adapter.runTurn(params, { onText: cb.onText })
      this.history.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })
      if (turn.toolCalls.length === 0) break

      const { opCalls, declareCalls } = splitTools(turn.toolCalls)
      // Structure is declared in the review step; ack any premature declaration and skip it.
      for (const d of declareCalls)
        this.history.push({ role: 'tool', toolCallId: d.id, content: 'noted — declare structure in the review step' })

      const applied = this.applyOpCalls(port, opCalls, null)
      if (applied > 0) mutated = true
      cb.onToolsApplied(`已对画布执行 ${applied}/${turn.toolCalls.length} 个操作`)
    }
    return mutated
  }

  /** Show the rendered drawing once and let the model declare structure + correct it. */
  private async reviewGate(port: CanvasPort, cb: SendCallbacks): Promise<void> {
    const shapes = port.snapshot('selection')
    const marks = nodeMarks(shapes)
    const image = await port.exportImage('selection', marks)
    if (!image) return

    for (const m of this.history) if (m.role === 'user') delete m.image
    this.history.push({
      role: 'user',
      content: `${REVIEW_PROMPT}\n\nRendered canvas:\n${formatCanvas(shapes, marks)}`,
      image,
    })

    const params: RunTurnParams = { system: SYSTEM, messages: this.history, tools: ALL_TOOLS }
    cb.onRequest?.(params, MAX_ITERATIONS)
    const turn = await this.adapter.runTurn(params, { onText: cb.onText })
    this.history.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })
    if (turn.toolCalls.length === 0) return // model judged it already good

    const { opCalls, declareCalls } = splitTools(turn.toolCalls)
    const relations: StructureRelation[] = []
    for (const d of declareCalls) {
      const parsed = parseStructure(d.args)
      relations.push(...parsed.relations)
      this.history.push({
        role: 'tool',
        toolCallId: d.id,
        content: JSON.stringify({ ok: true, accepted: parsed.relations.length, errors: parsed.errors }),
      })
    }
    const idByMark = new Map<number, string>()
    for (const [id, mk] of marks) idByMark.set(mk, id)
    const scope = relations.length ? resolveScope(relations, (mk) => idByMark.get(mk)) : null

    const applied = this.applyOpCalls(port, opCalls, scope)
    cb.onToolsApplied(`复核：结构 ${relations.length} 项，操作 ${applied} 个`)
  }

  /** Apply the op tool calls (with an optional B-pass scope) and push each result back.
   *  A scope with no ops still re-lays out the declared nodes. Returns the success count. */
  private applyOpCalls(port: CanvasPort, opCalls: OpCall[], scope: LayoutScope | null): number {
    const validOps: CanvasOp[] = opCalls.filter((c) => c.op).map((c) => c.op as CanvasOp)
    const results = validOps.length || scope ? port.apply(validOps, scope) : []
    let vi = 0
    let applied = 0
    for (const c of opCalls) {
      if (c.error) {
        this.history.push({ role: 'tool', toolCallId: c.id, content: `error: ${c.error}` })
        continue
      }
      const r = results[vi++]
      if (r.ok) applied++
      this.history.push({ role: 'tool', toolCallId: c.id, content: JSON.stringify(r) })
    }
    return applied
  }
}
