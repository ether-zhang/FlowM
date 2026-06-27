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
- When you draw a STRUCTURED region — a chain of connected nodes, a grid, a nested group — call \`declare_structure\` referencing the shapes by id, so the framework positions it precisely (straightens columns, evens spacing). Use your judgment: NOT everything is a flow; for free-form arrangements declare nothing. You can declare as you draw (you already have the ids). After you finish you'll also be shown the rendered result ONCE to fix any clear misplacement with \`move_shape\` (and declare any structure you missed).
- Keep prose brief; let the canvas do the talking.`

const MAX_ITERATIONS = 8

/** Tools the model may call: the canvas ops plus the structure declaration. */
const ALL_TOOLS = [...canvasTools, declareStructureTool]

const REVIEW_PROMPT = `Here is your drawing as it actually rendered. Each node is tagged with a mark number ([n]) to help you point at it in the image; the shape list gives each one's real id. Review it ONCE:
- Fix anything clearly misplaced or overlapping with \`move_shape\` (e.g. a sub-flow flung far from its parent, two boxes overlapping).
- If you spot a real structure you didn't already declare — a connected chain, a grid, a nesting — call \`declare_structure\` for it (by shape id).
- If it already looks right, reply briefly with NO tool calls.`

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

/** Ops whose ok result id is a shape the model created/moved this turn — the review
 *  looks at exactly these (not the whole canvas, which would drown a complex board). */
const REVIEWABLE_OPS = new Set(['create_geo', 'create_text', 'connect_shapes', 'move_shape'])

/** Union two B-pass scopes (the per-batch declaration into the accumulated turn scope). */
function mergeScope(into: LayoutScope | null, add: LayoutScope): LayoutScope {
  if (!into) return add
  for (const id of add.spacing) into.spacing.add(id)
  for (const id of add.overlap) into.overlap.add(id)
  return into
}

/** One set-of-mark number per NODE (arrows aren't marked), in snapshot order. */
function nodeMarks(shapes: CanvasShape[]): Map<string, number> {
  let n = 0
  const m = new Map<string, number>()
  for (const s of shapes) if (s.type !== 'arrow') m.set(s.id, ++n)
  return m
}

/**
 * Grow the review set with the shapes this turn's new arrows attach to — including
 * pre-existing parents the new work hangs off. Without this, those arrows dangle in
 * the review image and the model can't judge the new region's placement relative to
 * what it connects into (e.g. a sub-flow flung far from its parent). One hop only.
 */
function withConnectedContext(port: CanvasPort, changed: ReadonlySet<string>): Set<string> {
  const out = new Set(changed)
  for (const s of port.snapshot('all')) {
    if (s.type === 'arrow' && changed.has(s.id)) {
      if (s.from) out.add(s.from)
      if (s.to) out.add(s.to)
    }
  }
  return out
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
  /**
   * Structure scope declared so far in THIS user turn (build loop + review), accumulated.
   * A flow's `declare_structure` and the `connect_shapes` forming its edges often land in
   * different tool batches (e.g. the model declares early, then re-connects with real ids
   * a turn later because cross-turn refs failed). The B passes only straighten when scope
   * AND edges are live in the same `apply`, so the authorisation must outlive one batch:
   * we keep it for the turn and pass it to every `apply`. Reset at the start of each send.
   */
  private turnScope: LayoutScope | null = null
  /**
   * create-ref → real id, accumulated across THIS user turn. A `ref` (e.g. "p1") is
   * minted and resolved inside one `apply` batch, so a model that creates in one batch
   * then connects with that ref a batch later fails (`unresolved p1`). We remember the
   * refs from every create result this turn and rewrite later batches' connect from/to
   * to the real id, so the model's shorthand works regardless of batching. A ref created
   * in the same batch shadows this map (the port resolves those locally). Reset each send.
   */
  private refMap = new Map<string, string>()

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
    this.turnScope = null // declarations are scoped to this user turn; start fresh
    this.refMap.clear() // create-refs likewise live only within this user turn
    // What the user selected at request time — folded into the review set so the model's
    // new work is shown stitched to the diagram it was asked to expand, not in isolation.
    const selection = port.selectionScope()
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

    const changed = await this.runBuildLoop(port, cb)
    // One visual-review round over what the model created/changed this turn (plus the shapes
    // its new arrows attach to) UNION the user's original selection region — so the review
    // image shows the new work stitched to what was selected, while still not dumping the
    // whole canvas (which would drown a complex board) when nothing was selected.
    if (changed.size > 0) {
      const reviewIds = withConnectedContext(port, changed)
      if (selection) for (const id of selection) reviewIds.add(id)
      await this.reviewGate(port, cb, reviewIds)
    }
  }

  /** Build phase: let the model create/connect/move/declare until it stops calling tools.
   *  Returns the ids of shapes it created/moved this turn (what the review will inspect). */
  private async runBuildLoop(port: CanvasPort, cb: SendCallbacks): Promise<Set<string>> {
    const changed = new Set<string>()
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const params: RunTurnParams = { system: SYSTEM, messages: this.history, tools: ALL_TOOLS }
      cb.onRequest?.(params, i)
      const turn = await this.adapter.runTurn(params, { onText: cb.onText })
      this.history.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })
      if (turn.toolCalls.length === 0) break
      const applied = this.processToolCalls(port, turn.toolCalls, { changed, persistScope: true })
      cb.onToolsApplied(`已对画布执行 ${applied}/${turn.toolCalls.length} 个操作`)
    }
    return changed
  }

  /** Show just the shapes the model created/changed this turn and let it fix misplacements
   *  (and declare any structure it missed). Scoped to `ids`, so a big existing board stays
   *  out of the way and the model only reasons about its own fresh work. */
  private async reviewGate(port: CanvasPort, cb: SendCallbacks, ids: ReadonlySet<string>): Promise<void> {
    const shapes = port.snapshot('all', ids)
    const marks = nodeMarks(shapes)
    const image = await port.exportImage('all', marks, ids)
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

    // Review uses ONLY a scope freshly declared in this review turn — never the persisted
    // build scope. Otherwise a move_shape correcting a flow node would be immediately
    // re-flowed (clobbered) by the build's still-active straighten. The build already
    // straightened; review is for manual fixes + any newly-spotted structure.
    const applied = this.processToolCalls(port, turn.toolCalls, { persistScope: false })
    cb.onToolsApplied(`复核：执行 ${applied} 项调整`)
  }

  /** Process one turn's tool calls: parse any structure declarations into a B-pass scope,
   *  apply the canvas ops under that scope, and push a result for EVERY call (so the next
   *  request never has a dangling tool_call). Returns the success count. */
  private processToolCalls(
    port: CanvasPort,
    toolCalls: LlmToolCall[],
    opts: { changed?: Set<string>; persistScope: boolean },
  ): number {
    const { opCalls, declareCalls } = splitTools(toolCalls)
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
    const batchScope = relations.length ? resolveScope(relations) : null
    // Build phase: accumulate into the turn scope (it must outlive a single apply — the
    // edges that make a declared flow straightenable often arrive a batch later) and apply
    // it. Review phase: apply ONLY this turn's fresh declaration, never the persisted build
    // scope, so a manual move_shape fix isn't immediately re-flowed away.
    let scope: LayoutScope | null
    if (opts.persistScope) {
      if (batchScope) this.turnScope = mergeScope(this.turnScope, batchScope)
      scope = this.turnScope
    } else {
      scope = batchScope
    }
    return this.applyOpCalls(port, opCalls, scope, opts.changed)
  }

  /**
   * Rewrite connect_shapes endpoints that name a ref minted in an EARLIER batch this turn
   * (now a real id in refMap) — the port only resolves refs created in the current batch.
   * A ref created in THIS batch shadows the map (left untouched; the port resolves it).
   */
  private resolveCrossBatchRefs(ops: CanvasOp[]): CanvasOp[] {
    const localRefs = new Set<string>()
    for (const op of ops) if ((op.op === 'create_geo' || op.op === 'create_text') && op.ref) localRefs.add(op.ref)
    const lookup = (key: string): string | undefined => (localRefs.has(key) ? undefined : this.refMap.get(key))
    return ops.map((op) => {
      if (op.op !== 'connect_shapes') return op
      const from = lookup(op.from)
      const to = lookup(op.to)
      return from || to ? { ...op, from: from ?? op.from, to: to ?? op.to } : op
    })
  }

  /** Apply the op tool calls (with an optional B-pass scope) and push each result back.
   *  A scope with no ops still re-lays out the declared nodes. Collects created/moved ids
   *  into `changed` (for the review). Returns the success count. */
  private applyOpCalls(
    port: CanvasPort,
    opCalls: OpCall[],
    scope: LayoutScope | null,
    changed?: Set<string>,
  ): number {
    const validOps: CanvasOp[] = opCalls.filter((c) => c.op).map((c) => c.op as CanvasOp)
    const resolved = this.resolveCrossBatchRefs(validOps)
    const results = resolved.length || scope ? port.apply(resolved, scope) : []
    // Remember this batch's create-refs so a later batch's connect can target them by ref.
    for (const r of results) if (r.ok && r.id && r.ref) this.refMap.set(r.ref, r.id)
    let vi = 0
    let applied = 0
    for (const c of opCalls) {
      if (c.error) {
        this.history.push({ role: 'tool', toolCallId: c.id, content: `error: ${c.error}` })
        continue
      }
      const r = results[vi++]
      if (r.ok) {
        applied++
        if (changed && r.id && REVIEWABLE_OPS.has(r.op)) changed.add(r.id)
      }
      this.history.push({ role: 'tool', toolCallId: c.id, content: JSON.stringify(r) })
    }
    return applied
  }
}
