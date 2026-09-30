/**
 * Provider- and canvas-library-neutral orchestration for deterministic layout repair.
 * Pure geometry lives in layout.ts/edgeRouting.ts, while a concrete canvas port owns
 * element measurement and mutation.
 */
import { resolveOverlaps } from './layout'
import { type Pt } from './bindingGeometry'
import { type CompiledLayoutPlan, type PlannedRouteEdge } from './layoutPlan'
import { expandFlowSpacing } from './layoutPreservation'

export interface PassContext {
  /** Current compiled plan. Applying node moves invalidates it in the concrete port. */
  plan(): CompiledLayoutPlan
  /** Apply top-left positions to nodes in the concrete scene. */
  applyMoves(moves: Map<string, Pt>, stage: 'spacing' | 'overlap'): void
  /** Route the complete edge batch against shared lane and label occupancy. */
  routeArrows(edges: readonly PlannedRouteEdge[]): void
}

/**
 * The legacy invariant category does not move nodes. Endpoint attachment is geometric;
 * route choice preserves existing bends where possible. Intent passes move nodes only
 * within model authorization and must also pass composition-preservation checks.
 */
export type PassKind = 'invariant' | 'intent'

export interface LayoutPass {
  readonly name: string
  readonly kind: PassKind
  run(ctx: PassContext): void
}

export const spacingPass: LayoutPass = {
  name: 'spacing',
  kind: 'intent',
  run(ctx) {
    const spacing = ctx.plan().intent.spacing
    if (!spacing.enabled) return
    ctx.applyMoves(expandFlowSpacing(spacing.nodes, spacing.edges), 'spacing')
  },
}

export const avoidPass: LayoutPass = {
  name: 'avoid',
  kind: 'intent',
  run(ctx) {
    const plan = ctx.plan()
    const overlap = plan.intent.overlap
    if (!overlap.enabled) return
    ctx.applyMoves(resolveOverlaps([...overlap.nodes], { ignorePairs: plan.preservation.ignoredOverlaps }), 'overlap')
  },
}

export const arrowPass: LayoutPass = {
  name: 'arrows',
  kind: 'invariant',
  run(ctx) {
    ctx.routeArrows(ctx.plan().routing.edges)
  },
}

/** Node intent settles first; edge geometry is compiled again from final positions. */
export const DEFAULT_PASSES: readonly LayoutPass[] = [spacingPass, avoidPass, arrowPass]

export const INVARIANT_PASSES: readonly LayoutPass[] = DEFAULT_PASSES.filter((pass) => pass.kind === 'invariant')
export const INTENT_PASSES: readonly LayoutPass[] = DEFAULT_PASSES.filter((pass) => pass.kind === 'intent')

export function runPasses(ctx: PassContext, passes: readonly LayoutPass[] = DEFAULT_PASSES): void {
  for (const pass of passes) pass.run(ctx)
}
