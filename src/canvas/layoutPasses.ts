/**
 * Post-process pipeline — the adjustments FlowM runs on the model's output after a
 * batch of ops (even spacing, de-overlap, route arrows…). Each step is a `LayoutPass`
 * behind a small interface, so new concerns (e.g. colouring) plug in by implementing
 * the interface and joining the list — no editing of the orchestration.
 *
 * A pass is pure orchestration over an abstract `PassContext`; the concrete,
 * Excalidraw-aware context is supplied by the port. So the passes and their ordering
 * are library-agnostic and unit-testable, while the port owns the real element
 * mutation. This mirrors how `layout.ts`/`bindingGeometry.ts` keep the *algorithms*
 * pure — here it's the *orchestration* that's decoupled.
 */
import { resolveOverlaps, normalizeSpacing, type LayoutBox, type SpacingEdge } from './layout'
import { type Pt } from './bindingGeometry'

/**
 * What a pass may do to the scene, without knowing it's Excalidraw. The port supplies
 * the concrete implementation. Grow this interface as new post-process concerns arrive
 * (a colour pass might add `recolor(id, …)`, an align pass `snapToGrid()`, etc.).
 */
/**
 * Which nodes each B pass may move, derived from the model's structure declarations
 * (see docs/structure-schema.md). `null` ⇒ no declarations yet (pre-gate): the passes
 * fall back to today's global behaviour. When present, a pass touches ONLY the ids in
 * its set; everything else is frozen (kept as a pinned obstacle where relevant).
 */
export interface StructureScope {
  /** Node ids the flow realiser (spacing pass) may move. */
  spacing: Set<string>
  /** Node ids the nonOverlap realiser (avoid pass) may move; the rest stay as obstacles. */
  overlap: Set<string>
}

export interface PassContext {
  /** How many shapes were created this batch (spacing only re-flows fresh diagrams). */
  readonly createdCount: number
  /** Box snapshot of the scene (movable flags set for this batch's new/moved shapes). */
  boxes(): LayoutBox[]
  /** Bound-arrow connections, each carrying its label size (for label-aware spacing). */
  edges(): SpacingEdge[]
  /** Declared scope for the B passes, or null to run globally (pre-gate behaviour). */
  structure(): StructureScope | null
  /** Apply position deltas to the scene (and record the shapes as displaced). */
  applyMoves(moves: Map<string, Pt>): void
  /** Ids of arrows whose geometry must be recomputed (they touch a new/displaced shape). */
  arrowsToUpdate(): string[]
  /** Recompute one arrow's endpoints + routing in place. */
  updateArrow(id: string): void
}

/**
 * Two kinds of pass, by whether it moves/resizes a NODE (see docs/structured-refine.md):
 *  - 'invariant' (A): only resolves how arrows attach to / route between already-placed
 *    nodes. Given the model's topology + placement, the geometry is a forced, unique
 *    value no intent ever objects to (an arrow must touch its shape) → runs blind, always.
 *  - 'intent' (B): repositions or resizes the nodes themselves. The right answer depends
 *    on the intended structure (nest vs accident, grid vs free) → must be authorised by
 *    the model's vision over a declared scope; with no authorisation it FREEZES (no-op).
 */
export type PassKind = 'invariant' | 'intent'

export interface LayoutPass {
  readonly name: string
  readonly kind: PassKind
  run(ctx: PassContext): void
}

/** Even out spacing — only when new shapes appear (a pure move is left as placed).
 *  With a declared scope, only the flow nodes flow; others are excluded (frozen). */
export const spacingPass: LayoutPass = {
  name: 'spacing',
  kind: 'intent', // moves nodes → B
  run(ctx) {
    const scope = ctx.structure()
    const boxes = ctx.boxes()
    const edges = ctx.edges()
    if (scope) {
      // Structure-driven: flow exactly the declared nodes, regardless of createdCount
      // (the model explicitly asked for this layout, so re-flow even on a pure review).
      const nodes = boxes.filter((b) => scope.spacing.has(b.id))
      if (nodes.length === 0) return
      const flowEdges = edges.filter((e) => scope.spacing.has(e.from) && scope.spacing.has(e.to))
      ctx.applyMoves(normalizeSpacing(nodes, flowEdges))
      return
    }
    // No declarations (pre-gate): only re-flow when fresh shapes appear.
    if (ctx.createdCount > 0) ctx.applyMoves(normalizeSpacing(boxes, edges))
  },
}

/** Push any genuinely-overlapping boxes apart. With a declared scope, only the
 *  nonOverlap nodes may move; the rest stay put but still act as obstacles. */
export const avoidPass: LayoutPass = {
  name: 'avoid',
  kind: 'intent', // moves nodes → B
  run(ctx) {
    const scope = ctx.structure()
    const boxes = ctx.boxes()
    if (!scope) {
      ctx.applyMoves(resolveOverlaps(boxes))
      return
    }
    const scoped = boxes.map((b) => (scope.overlap.has(b.id) ? b : { ...b, movable: false }))
    ctx.applyMoves(resolveOverlaps(scoped))
  },
}

/** Re-solve + route every arrow whose endpoints moved. */
export const arrowPass: LayoutPass = {
  name: 'arrows',
  kind: 'invariant', // touches only arrows → A
  run(ctx) {
    for (const id of ctx.arrowsToUpdate()) ctx.updateArrow(id)
  },
}

/**
 * Order matters: intent passes (B) move nodes first, then the invariant arrow pass (A)
 * re-attaches arrows to the settled nodes. The eventual gated pipeline runs A on the
 * model's raw nodes for the first image, gates B on the model's structure declarations,
 * then A again — see docs/structured-refine.md §2. For now (no gate yet) B runs on the
 * whole batch as before, so behaviour is unchanged.
 */
export const DEFAULT_PASSES: readonly LayoutPass[] = [spacingPass, avoidPass, arrowPass]

/** Passes split by kind, for the gated pipeline to schedule A and B separately. */
export const INVARIANT_PASSES: readonly LayoutPass[] = DEFAULT_PASSES.filter((p) => p.kind === 'invariant')
export const INTENT_PASSES: readonly LayoutPass[] = DEFAULT_PASSES.filter((p) => p.kind === 'intent')

export function runPasses(ctx: PassContext, passes: readonly LayoutPass[] = DEFAULT_PASSES): void {
  for (const pass of passes) pass.run(ctx)
}
