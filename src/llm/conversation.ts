import {
  type CanvasPort,
  type CanvasShape,
  type CanvasOp,
  type DiagramPlan,
  type LayoutScope,
  type StructureRelation,
  canvasTools,
  declareDiagramTool,
  declareStructureTool,
  diagramPlanCounts,
  diagramPlanRefs,
  formatCanvas,
  parseDiagramPlan,
  parseOp,
  parseStructure,
  resolveCanvasOpReferences,
  resolveScope,
  resolveStructureRelationReferences,
  toolCallToOp,
} from '../protocol'
import type { CanvasTurnRuntime, RunTurnParams, TurnCallbacks } from './canvasTurn'
import type { AgentActivityEvent, AgentQuestionAnswer } from '../agent'
import type { LlmMessage, LlmQuestion, LlmToolCall, LlmTurn } from './types'
import {
  FLOWM_CANVAS_FINALIZE_PROMPT,
  FLOWM_CANVAS_REVIEW_PROMPT,
  FLOWM_CANVAS_SYSTEM_PROMPT,
} from './canvasPrompt'

const MAX_ITERATIONS = 8

/** Tools the model may call: the canvas ops plus the structure declaration. */
const ALL_TOOLS = [declareDiagramTool, ...canvasTools, declareStructureTool]
const REVIEW_TOOL_NAMES = new Set(['move_shape', 'place_region', 'declare_structure'])
const REVIEW_TOOLS = ALL_TOOLS.filter((tool) => REVIEW_TOOL_NAMES.has(tool.name))

const questionText = (question: LlmQuestion) => question.items.map((item) => item.prompt).join('\n')

interface OpCall {
  id: string
  op?: CanvasOp
  error?: string
}
interface DeclareCall {
  id: string
  args?: Record<string, unknown>
  error?: string
}

interface BuildResult {
  changed: Set<string>
  text: string
  interrupted: boolean
}

interface PhaseResult {
  text: string
  interrupted: boolean
}

interface ToolAccess {
  allowedNames: ReadonlySet<string>
  editableIds: ReadonlySet<string>
}

interface ReviewScope {
  reviewTargetIds: Set<string>
  contextIds: Set<string>
  editableIds: Set<string>
}

/** Split a turn's tool calls into canvas ops (validated) and structure declarations. */
function splitTools(
  toolCalls: LlmToolCall[],
  access?: ToolAccess,
): { opCalls: OpCall[]; diagramCalls: DeclareCall[]; declareCalls: DeclareCall[] } {
  const opCalls: OpCall[] = []
  const diagramCalls: DeclareCall[] = []
  const declareCalls: DeclareCall[] = []
  for (const tc of toolCalls) {
    if (access && !access.allowedNames.has(tc.name)) {
      const error = `${tc.name} is not allowed during review`
      if (tc.name === 'declare_diagram') diagramCalls.push({ id: tc.id, error })
      else if (tc.name === 'declare_structure') declareCalls.push({ id: tc.id, error })
      else opCalls.push({ id: tc.id, error })
      continue
    }
    if (tc.name === 'declare_diagram') {
      diagramCalls.push({ id: tc.id, args: tc.args })
      continue
    }
    if (tc.name === 'declare_structure') {
      declareCalls.push({ id: tc.id, args: tc.args })
      continue
    }
    try {
      const op = parseOp(toolCallToOp(tc.name, tc.args))
      // Access is checked after symbolic refs are resolved. Checking a create ref here would
      // incorrectly treat it as a context-only real id.
      opCalls.push({ id: tc.id, op })
    } catch (e) {
      opCalls.push({ id: tc.id, error: (e as Error).message })
    }
  }
  return { opCalls, diagramCalls, declareCalls }
}

function operationAccessError(op: CanvasOp, editableIds: ReadonlySet<string>): string | undefined {
  if (op.op === 'move_shape' && !editableIds.has(op.id)) {
    return `review cannot move context-only shape ${op.id}`
  }
  if (op.op === 'place_region') {
    const denied = op.ids.filter((id) => !editableIds.has(id))
    if (denied.length) return `review cannot place context-only shapes: ${denied.join(', ')}`
  }
  return undefined
}

function relationIds(relation: StructureRelation): string[] {
  return relation.kind === 'contain'
    ? [relation.parent, ...relation.children]
    : relation.nodes
}

/** Ops whose ok result id is a shape the model created/moved this turn — the review
 *  looks at exactly these (not the whole canvas, which would drown a complex board). */
const REVIEWABLE_OPS = new Set(['create_geo', 'create_text', 'connect_shapes', 'move_shape', 'place_region'])
const DEFERRED_REFERENCE_OPS = new Set(['move_shape', 'place_region', 'update_text', 'delete_shape'])

/** Union two B-pass scopes (the per-batch declaration into the accumulated turn scope). */
function mergeScope(into: LayoutScope | null, add: LayoutScope): LayoutScope {
  if (!into) return add
  if (into.relations && add.relations) {
    const relations = [...into.relations, ...add.relations]
    const unique = new Map(relations.map((relation) => [JSON.stringify(relation), relation]))
    return resolveScope([...unique.values()])
  }
  for (const id of add.spacing) into.spacing.add(id)
  for (const id of add.overlap) into.overlap.add(id)
  return into
}

/** Shape types that are NODES the model points at / declares structure over — the
 *  system prompt's "box / ellipse / diamond / standalone text". Arrows, freedraw strokes
 *  and other primitives are NOT marked: chips over a hand-drawn sketch occlude the strokes
 *  and atomise a figure into N "nodes", hurting the model's read of it. */
const MARKABLE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'triangle', 'text'])

/** One set-of-mark number per markable NODE, in snapshot order. */
function nodeMarks(shapes: CanvasShape[]): Map<string, number> {
  let n = 0
  const m = new Map<string, number>()
  for (const s of shapes) if (MARKABLE_TYPES.has(s.type)) m.set(s.id, ++n)
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

function createReviewScope(
  port: CanvasPort,
  changed: ReadonlySet<string>,
  selection: ReadonlySet<string> | null,
): ReviewScope {
  const reviewTargetIds = new Set(changed)
  const editableIds = new Set(changed)
  const contextIds = port.regionOf(withConnectedContext(port, reviewTargetIds))
  if (selection) for (const id of selection) contextIds.add(id)
  return { reviewTargetIds, contextIds, editableIds }
}

function reviewScopeText(scope: ReviewScope): string {
  const ids = (values: ReadonlySet<string>) => [...values].sort().join(', ') || '(none)'
  const contextOnlyIds = new Set(
    [...scope.contextIds].filter((id) => !scope.editableIds.has(id)),
  )
  return [
    `Review target ids: ${ids(scope.reviewTargetIds)}`,
    `Editable ids: ${ids(scope.editableIds)}`,
    `Context-only ids (do not modify): ${ids(contextOnlyIds)}`,
  ].join('\n')
}

export interface SendCallbacks {
  onText(text: string): void
  /** Fired after a batch of canvas ops is applied, with a short human summary. */
  onToolsApplied(summary: string): void
  /** Harness request/response trace. */
  onDebug?(text: string): void
  /** The assistant needs a yes/no/other user decision before continuing. */
  onQuestion?(question: LlmQuestion, source?: 'model'): void
  /** Activity emitted by the harness and FlowM's canvas orchestration. */
  onActivity?(event: AgentActivityEvent, source?: 'model'): void
}

/** Runs a canvas workflow. Long-lived conversation history belongs to the harness. */
export class Conversation {
  private history: LlmMessage[] = []
  private runtime: CanvasTurnRuntime
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
  /** One semantic root plan for a non-trivial diagram, scoped to the current user turn. */
  private diagramPlan: DiagramPlan | null = null
  /**
   * Relations may intentionally be declared before their create refs are materialised in a
   * later build batch. Keep those symbolic relations for this user turn and activate them as
   * soon as every referenced shape exists.
   */
  private pendingRelations: StructureRelation[] = []
  private cancelled = false

  constructor(runtime: CanvasTurnRuntime) {
    this.runtime = runtime
  }

  reset(messages: LlmMessage[] = []) {
    this.history = messages
  }

  get messages(): LlmMessage[] {
    return this.history
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose?.()
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    await this.runtime.cancel?.()
  }

  private checkCancelled(): void {
    if (this.cancelled) throw new Error('Canvas request cancelled')
  }

  private async runTurn(params: RunTurnParams, callbacks: TurnCallbacks): Promise<LlmTurn> {
    this.checkCancelled()
    const turn = await this.runtime.runTurn(params, callbacks)
    this.checkCancelled()
    return turn
  }

  async answerQuestion(answer: AgentQuestionAnswer): Promise<void> {
    if (!this.runtime.answerQuestion) throw new Error('This agent does not support in-flight questions')
    await this.runtime.answerQuestion(answer)
  }

  async send(userText: string, port: CanvasPort, cb: SendCallbacks): Promise<void> {
    this.history = [] // only this workflow's prompts and operation feedback live in the framework
    this.cancelled = false
    this.turnScope = null // declarations are scoped to this user turn; start fresh
    this.refMap.clear() // create-refs likewise live only within this user turn
    this.diagramPlan = null
    this.pendingRelations = []
    // What the user selected at request time — folded into the review set so the model's
    // new work is shown stitched to the diagram it was asked to expand, not in isolation.
    const selection = port.selectionScope()
    const shapes = port.snapshot('selection')
    const marks = nodeMarks(shapes)
    const context = formatCanvas(shapes, marks)
    const image = await port.exportImage('selection', marks)
    this.checkCancelled()

    // Keep only the newest turn's image: vision tokens are costly and stale
    // snapshots add little once the canvas has moved on.
    for (const m of this.history) if (m.role === 'user') delete m.image

    this.history.push({
      role: 'user',
      content: `Current canvas:\n${context}\n\n---\n${userText}`,
      ...(image ? { image } : {}),
    })

    const build = await this.runBuildLoop(port, cb)
    if (build.interrupted) return
    // One visual-review round over what the model created/changed this turn (plus the shapes
    // its new arrows attach to) UNION the user's original selection region — so the review
    // image shows the new work stitched to what was selected, while still not dumping the
    // whole canvas (which would drown a complex board) when nothing was selected.
    if (build.changed.size > 0) {
      const reviewScope = createReviewScope(port, build.changed, selection)
      const review = await this.reviewGate(port, cb, reviewScope)
      if (review.interrupted) return
      await this.finalize(cb, review.text || build.text)
    } else if (build.text) {
      cb.onText(build.text)
    }
  }

  /** Build phase: let the model create/connect/move/declare until it stops calling tools.
   *  Returns the ids of shapes it created/moved this turn (what the review will inspect). */
  private async runBuildLoop(port: CanvasPort, cb: SendCallbacks): Promise<BuildResult> {
    const changed = new Set<string>()
    let text = ''
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const params: RunTurnParams = {
        phase: 'build',
        system: FLOWM_CANVAS_SYSTEM_PROMPT,
        messages: this.history,
        tools: ALL_TOOLS,
      }
      const turn = await this.runTurn(params, {
        onDebug: cb.onDebug,
        onQuestion: cb.onQuestion,
        onActivity: cb.onActivity,
      })
      if (turn.question) {
        this.history.push({ role: 'assistant', content: turn.text || questionText(turn.question) })
        cb.onQuestion?.(turn.question)
        return { changed, text, interrupted: true }
      }
      this.history.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })
      if (turn.text) text = turn.text
      if (turn.toolCalls.length === 0) {
        const missing = this.missingDiagramRefs(port)
        if (missing.length && i < MAX_ITERATIONS - 1) {
          this.history.push({
            role: 'user',
            content:
              `FlowM diagram plan is incomplete. Materialize these planned shape refs before finishing: ${missing.join(', ')}`,
          })
          continue
        }
        break
      }
      this.emitCommentary(cb, 'build', i, turn.text)
      const applied = await this.processToolCalls(port, turn.toolCalls, { changed, persistScope: true })
      cb.onToolsApplied(`已对画布执行 ${applied}/${turn.toolCalls.length} 个操作`)
    }
    return { changed, text, interrupted: false }
  }

  /** Show the model its fresh work IN CONTEXT and let it fix misplacements (and declare any
   *  structure it missed). Reviewed over the whole spatial REGION the new/changed shapes occupy —
   *  their bounding box plus every shape sitting in it — not an isolated cutout of only the new
   *  shapes: an overlap or crowding against an EXISTING neighbour is invisible in a cutout that
   *  omits that neighbour. A far-off untouched board still stays out of the way (it's outside the
   *  region), so the model keeps reasoning mostly about its own work, now against real surroundings. */
  private async reviewGate(port: CanvasPort, cb: SendCallbacks, scope: ReviewScope): Promise<PhaseResult> {
    const shapes = port.snapshot('all', scope.contextIds)
    const marks = nodeMarks(shapes)
    const image = await port.exportImage('all', marks, scope.contextIds)
    if (!image) return { text: '', interrupted: false }

    for (const m of this.history) if (m.role === 'user') delete m.image
    this.history.push({
      role: 'user',
      content:
        `${FLOWM_CANVAS_REVIEW_PROMPT}\n\n${reviewScopeText(scope)}` +
        `\n\nRendered canvas:\n${formatCanvas(shapes, marks)}`,
      image,
    })

    const params: RunTurnParams = {
      phase: 'review',
      system: FLOWM_CANVAS_SYSTEM_PROMPT,
      messages: this.history,
      tools: REVIEW_TOOLS,
    }
    const turn = await this.runTurn(params, {
      onDebug: cb.onDebug,
      onQuestion: cb.onQuestion,
      onActivity: cb.onActivity,
    })
    if (turn.question) {
      this.history.push({ role: 'assistant', content: turn.text || questionText(turn.question) })
      cb.onQuestion?.(turn.question)
      return { text: turn.text, interrupted: true }
    }
    this.history.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })
    if (turn.toolCalls.length === 0) return { text: turn.text, interrupted: false }

    this.emitCommentary(cb, 'review', 0, turn.text)
    // Review uses ONLY a scope freshly declared in this review turn — never the persisted
    // build scope. Otherwise a move_shape correcting a flow node would be immediately
    // re-flowed (clobbered) by the build's still-active straighten. The build already
    // straightened; review is for manual fixes + any newly-spotted structure.
    const applied = await this.processToolCalls(port, turn.toolCalls, {
      persistScope: false,
      access: { allowedNames: REVIEW_TOOL_NAMES, editableIds: scope.editableIds },
    })
    cb.onToolsApplied(`复核：执行 ${applied} 项调整`)
    return { text: turn.text, interrupted: false }
  }

  /** Final explanation is a separate no-tools phase, emitted to chat exactly once. */
  private async finalize(cb: SendCallbacks, fallbackText: string): Promise<void> {
    this.history.push({ role: 'user', content: FLOWM_CANVAS_FINALIZE_PROMPT })
    const params: RunTurnParams = {
      phase: 'finalize',
      system: FLOWM_CANVAS_SYSTEM_PROMPT,
      messages: this.history,
      tools: [],
    }
    const turn = await this.runTurn(params, {
      onDebug: cb.onDebug,
      onQuestion: cb.onQuestion,
      onActivity: cb.onActivity,
    })
    if (turn.question) {
      this.history.push({ role: 'assistant', content: turn.text || questionText(turn.question) })
      cb.onQuestion?.(turn.question)
      return
    }
    this.history.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })
    const text = turn.text || fallbackText
    if (text) cb.onText(text)
  }

  private emitCommentary(
    cb: SendCallbacks,
    phase: 'build' | 'review',
    iteration: number,
    text: string,
  ): void {
    if (!text.trim()) return
    cb.onActivity?.({
      type: 'commentary_delta',
      id: `flowm-${phase}-${iteration}`,
      delta: text,
    })
  }

  /** Process one turn's tool calls: parse any structure declarations into a B-pass scope,
   *  apply the canvas ops under that scope, and push a result for EVERY call (so the next
   *  request never has a dangling tool_call). Returns the success count. */
  private async processToolCalls(
    port: CanvasPort,
    toolCalls: LlmToolCall[],
    opts: { changed?: Set<string>; persistScope: boolean; access?: ToolAccess },
  ): Promise<number> {
    const { opCalls, diagramCalls, declareCalls } = splitTools(toolCalls, opts.access)
    const planErrors = this.compileDiagramPlan(diagramCalls)
    const createErrors = this.validatePlannedCreates(opCalls, declareCalls.length > 0)
    const blockingErrors = [...planErrors, ...createErrors]
    if (blockingErrors.length) {
      const reason = `diagram plan rejected: ${blockingErrors.join('; ')}`
      for (const call of opCalls) {
        this.history.push({
          role: 'tool',
          toolCallId: call.id,
          content: call.error ? `error: ${call.error}` : `error: ${reason}`,
        })
      }
      for (const call of declareCalls) {
        this.history.push({
          role: 'tool',
          toolCallId: call.id,
          content: call.error ? `error: ${call.error}` : `error: ${reason}`,
        })
      }
      return 0
    }
    const earlyCalls = opCalls.filter((call) =>
      call.error || !call.op || !DEFERRED_REFERENCE_OPS.has(call.op.op))
    const deferredCalls = opCalls.filter((call) =>
      !!call.op && DEFERRED_REFERENCE_OPS.has(call.op.op))

    // Materialise creates/connects first. This is one logical model batch: the split is an
    // internal compile step that makes every create ref available to declarations and region
    // placement without forcing another provider turn.
    // Keep the materialized model layout intact until this batch's declarations (including
    // freeze) are known. The final apply below performs the combined intent repair once.
    let applied = await this.applyOpCalls(port, earlyCalls, null, opts.changed)

    const liveIds = new Set(port.snapshot('all').map((shape) => shape.id))
    const lookup = (key: string): string | undefined =>
      this.refMap.get(key) ?? (liveIds.has(key) ? key : undefined)
    const relations: StructureRelation[] = []

    // Activate older declarations whose refs were created by this batch.
    const stillPending: StructureRelation[] = []
    for (const relation of this.pendingRelations) {
      const resolved = resolveStructureRelationReferences(relation, lookup)
      if (resolved.unresolved.length) stillPending.push(relation)
      else relations.push(resolved.value)
    }
    this.pendingRelations = stillPending

    for (const d of declareCalls) {
      if (d.error) {
        this.history.push({ role: 'tool', toolCallId: d.id, content: `error: ${d.error}` })
        continue
      }
      const parsed = parseStructure(d.args ?? {})
      let resolvedCount = 0
      let pendingCount = 0
      const denied = new Set<string>()
      for (const relation of parsed.relations) {
        const resolved = resolveStructureRelationReferences(relation, lookup)
        if (resolved.unresolved.length) {
          this.pendingRelations.push(relation)
          pendingCount++
          continue
        }
        const forbidden = opts.access
          ? relationIds(resolved.value).filter((id) => !opts.access?.editableIds.has(id))
          : []
        if (forbidden.length) {
          for (const id of forbidden) denied.add(id)
          continue
        }
        relations.push(resolved.value)
        resolvedCount++
      }
      if (denied.size) {
        this.history.push({
          role: 'tool',
          toolCallId: d.id,
          content: `error: review cannot declare structure over context-only shapes: ${[...denied].join(', ')}`,
        })
        continue
      }
      this.history.push({
        role: 'tool',
        toolCallId: d.id,
        content: JSON.stringify({
          ok: true,
          accepted: resolvedCount + pendingCount,
          resolved: resolvedCount,
          pending: pendingCount,
          errors: parsed.errors,
        }),
      })
    }

    const batchScope = relations.length ? resolveScope(relations) : null
    // Build phase accumulates real ids for the user turn. Review uses only a declaration
    // made in that review, so a manual correction cannot be overwritten by the build flow.
    let scope: LayoutScope | null
    if (opts.persistScope) {
      if (batchScope) this.turnScope = mergeScope(this.turnScope, batchScope)
      scope = this.turnScope
    } else {
      scope = batchScope
    }

    const resolvedDeferred = deferredCalls.map((call): OpCall => {
      if (!call.op) return call
      const resolved = resolveCanvasOpReferences(call.op, lookup)
      if (resolved.unresolved.length) {
        return { id: call.id, error: `unresolved shape reference(s): ${resolved.unresolved.join(', ')}` }
      }
      const error = opts.access
        ? operationAccessError(resolved.value, opts.access.editableIds)
        : undefined
      return error ? { id: call.id, error } : { id: call.id, op: resolved.value }
    })
    applied += await this.applyOpCalls(port, resolvedDeferred, scope, opts.changed)
    // Append feedback only after EVERY tool result, including declaration results. Read the
    // final apply so a later scoped repair cannot leave an already-resolved warning in history.
    const didApply = scope || [...earlyCalls, ...resolvedDeferred].some((call) => call.op)
    const layoutWarnings = didApply ? port.layoutDiagnostics?.() ?? [] : []
    if (layoutWarnings.length) {
      this.history.push({
        role: 'user',
        content: `FlowM layout diagnostics (automatic repair preserved the original composition):\n${layoutWarnings.join('\n')}`,
      })
    }
    return applied
  }

  /** Parse the non-drawing root declaration before any shapes in the batch are applied. */
  private compileDiagramPlan(calls: DeclareCall[]): string[] {
    const errors: string[] = []
    for (const call of calls) {
      if (call.error) {
        this.history.push({ role: 'tool', toolCallId: call.id, content: `error: ${call.error}` })
        errors.push(call.error)
        continue
      }
      const parsed = parseDiagramPlan(call.args ?? {})
      if (!parsed.plan) {
        const error = parsed.errors.join('; ') || 'invalid diagram plan'
        this.history.push({ role: 'tool', toolCallId: call.id, content: `error: ${error}` })
        errors.push(error)
        continue
      }
      if (this.diagramPlan) {
        const error = 'declare_diagram may be accepted only once per user turn'
        this.history.push({ role: 'tool', toolCallId: call.id, content: `error: ${error}` })
        errors.push(error)
        continue
      }
      this.diagramPlan = parsed.plan
      const counts = diagramPlanCounts(parsed.plan)
      this.history.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify({
          ok: true,
          kind: parsed.plan.kind,
          regions: parsed.plan.regions.length,
          primary: counts.primary,
          supporting: counts.supporting,
        }),
      })
    }
    return errors
  }

  private missingDiagramRefs(port: CanvasPort): string[] {
    if (!this.diagramPlan) return []
    const liveIds = new Set(port.snapshot('all').map((shape) => shape.id))
    return [...diagramPlanRefs(this.diagramPlan)]
      .filter((ref) => !this.refMap.has(ref) && !liveIds.has(ref))
      .sort()
  }

  /** Enforce that a structured create batch materializes one declared semantic plan. */
  private validatePlannedCreates(calls: OpCall[], structureDeclared: boolean): string[] {
    const creates = calls
      .filter((call) => call.op?.op === 'create_geo')
      .map((call) => call.op as Extract<CanvasOp, { op: 'create_geo' }>)
    if (!creates.length) return []
    if (!this.diagramPlan) {
      return structureDeclared
        ? ['a create batch with declare_structure requires one declare_diagram operation in the same or an earlier build batch']
        : []
    }

    const planned = diagramPlanRefs(this.diagramPlan)
    const seen = new Set<string>()
    const errors: string[] = []
    for (const create of creates) {
      if (!create.ref) {
        errors.push('every planned create_geo operation must have a ref')
        continue
      }
      if (seen.has(create.ref)) errors.push(`duplicate create ref ${create.ref}`)
      seen.add(create.ref)
      if (!planned.has(create.ref)) errors.push(`create ref ${create.ref} is not assigned to a diagram region`)
    }
    return [...new Set(errors)]
  }

  /**
   * Rewrite connect_shapes endpoints that name a ref minted in an EARLIER batch this turn
   * (now a real id in refMap) — the port only resolves refs created in the current batch.
   * A ref created in THIS batch shadows the map (left untouched; the port resolves it).
   * Other ref-bearing operations are deliberately deferred by processToolCalls and resolved
   * through the same turn-level registry after this batch's creates are materialised.
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
  private async applyOpCalls(
    port: CanvasPort,
    opCalls: OpCall[],
    scope: LayoutScope | null,
    changed?: Set<string>,
  ): Promise<number> {
    const validOps: CanvasOp[] = opCalls.filter((c) => c.op).map((c) => c.op as CanvasOp)
    const resolved = this.resolveCrossBatchRefs(validOps)
    const results = resolved.length || scope ? await port.apply(resolved, scope) : []
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
        if (changed && REVIEWABLE_OPS.has(r.op)) {
          if (r.id) changed.add(r.id)
          if (r.ids) for (const id of r.ids) changed.add(id)
        }
      }
      this.history.push({ role: 'tool', toolCallId: c.id, content: JSON.stringify(r) })
    }
    return applied
  }
}
