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
export interface PassContext {
  /** How many shapes were created this batch (spacing only re-flows fresh diagrams). */
  readonly createdCount: number
  /** Box snapshot of the scene (movable flags set for this batch's new/moved shapes). */
  boxes(): LayoutBox[]
  /** Bound-arrow connections, each carrying its label size (for label-aware spacing). */
  edges(): SpacingEdge[]
  /** Apply position deltas to the scene (and record the shapes as displaced). */
  applyMoves(moves: Map<string, Pt>): void
  /** Ids of arrows whose geometry must be recomputed (they touch a new/displaced shape). */
  arrowsToUpdate(): string[]
  /** Recompute one arrow's endpoints + routing in place. */
  updateArrow(id: string): void
}

export interface LayoutPass {
  readonly name: string
  run(ctx: PassContext): void
}

/** Even out spacing — only when new shapes appear (a pure move is left as placed). */
export const spacingPass: LayoutPass = {
  name: 'spacing',
  run(ctx) {
    if (ctx.createdCount > 0) ctx.applyMoves(normalizeSpacing(ctx.boxes(), ctx.edges()))
  },
}

/** Push any genuinely-overlapping boxes apart. */
export const avoidPass: LayoutPass = {
  name: 'avoid',
  run(ctx) {
    ctx.applyMoves(resolveOverlaps(ctx.boxes()))
  },
}

/** Re-solve + route every arrow whose endpoints moved. */
export const arrowPass: LayoutPass = {
  name: 'arrows',
  run(ctx) {
    for (const id of ctx.arrowsToUpdate()) ctx.updateArrow(id)
  },
}

/** Order matters: space → clean leftover overlaps → fix arrows last. */
export const DEFAULT_PASSES: readonly LayoutPass[] = [spacingPass, avoidPass, arrowPass]

export function runPasses(ctx: PassContext, passes: readonly LayoutPass[] = DEFAULT_PASSES): void {
  for (const pass of passes) pass.run(ctx)
}
