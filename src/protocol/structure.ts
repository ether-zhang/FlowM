import { z } from 'zod'

/**
 * Structure declarations — how the model states the intended layout structure of a
 * region so the framework lays it out precisely (the B / intent passes, scoped to its
 * nodes); nodes in no relation are frozen. The model declares ONLY where a real
 * structure applies (a connected chain, a grid, a nesting) and skips free-form work —
 * that judgment is the model's. Nodes are referenced by shape id (the model has the ids
 * from its create results / the canvas list), so declarations can ride along with the
 * drawing rather than waiting for a separate marks pass. Pure, library-agnostic.
 */

/** A shape id (what create_geo/connect_shapes return, and what the canvas list shows). */
const NodeId = z.string().min(1)

export const StructureRelation = z.discriminatedUnion('kind', [
  // Flow chain: nodes advance down a single column (or right a row) — even spacing + axis snap.
  z.object({ kind: z.literal('flow'), nodes: z.array(NodeId).min(2), dir: z.enum(['down', 'right']).optional() }),
  // Align on a shared axis: 'col' = same x (a column), 'row' = same y (a row).
  z.object({
    kind: z.literal('align'),
    nodes: z.array(NodeId).min(2),
    axis: z.enum(['col', 'row']),
    at: z.enum(['min', 'center', 'max']).optional(),
  }),
  // Uniform grid, row-major; rows are implied by count / cols.
  z.object({ kind: z.literal('grid'), nodes: z.array(NodeId).min(1), cols: z.number().int().positive(), gap: z.number().optional() }),
  // Nesting: children live inside parent (parent grows; children kept within).
  z.object({ kind: z.literal('contain'), parent: NodeId, children: z.array(NodeId).min(1) }),
  // These must not overlap (scoped de-overlap).
  z.object({ kind: z.literal('nonOverlap'), nodes: z.array(NodeId).min(2) }),
  // Leave exactly as placed (hand-drawn / sketch, or to veto an inferred relation).
  z.object({ kind: z.literal('freeze'), nodes: z.array(NodeId).min(1) }),
])
export type StructureRelation = z.infer<typeof StructureRelation>

export interface ParsedStructure {
  relations: StructureRelation[]
  /** One message per dropped (malformed) relation — reported back, never fatal. */
  errors: string[]
}

/**
 * Validate a `declare_structure` payload. Each relation is checked independently: valid
 * ones are kept, malformed ones are dropped with an error message (mirrors the doc's
 * "drop the bad, report it, don't block the rest"). Only the SHAPE is validated here —
 * whether an id refers to a real, current shape is enforced downstream by `apply`
 * (it only moves shapes that exist and are in scope).
 */
export function parseStructure(input: unknown): ParsedStructure {
  const top = z.object({ relations: z.array(z.unknown()).optional() }).safeParse(input)
  const rawList = top.success && top.data.relations ? top.data.relations : []
  const relations: StructureRelation[] = []
  const errors: string[] = []
  rawList.forEach((raw, i) => {
    const r = StructureRelation.safeParse(raw)
    if (r.success) relations.push(r.data)
    else errors.push(`relation[${i}]: ${r.error.issues[0]?.message ?? 'invalid'}`)
  })
  return { relations, errors }
}

/** Which node ids each B (intent) pass may move, keyed by realiser. Mirrors the layout
 *  layer's StructureScope shape so it can be handed straight to `apply`. */
export interface LayoutScope {
  spacing: Set<string>
  overlap: Set<string>
}

/**
 * Turn declared relations into a per-pass id scope. `flow` nodes get even spacing AND
 * de-overlap (a flow shouldn't self-overlap); `nonOverlap` nodes get de-overlap only.
 * The other kinds (align/grid/contain/freeze) have no realiser yet, so they contribute
 * nothing — their nodes simply stay frozen for now. Ids of shapes that don't exist are
 * harmless: `apply` only moves shapes it actually finds in the scene.
 */
export function resolveScope(relations: StructureRelation[]): LayoutScope {
  const spacing = new Set<string>()
  const overlap = new Set<string>()
  for (const r of relations) {
    if (r.kind === 'flow') {
      for (const id of r.nodes) {
        spacing.add(id)
        overlap.add(id)
      }
    } else if (r.kind === 'nonOverlap') {
      for (const id of r.nodes) overlap.add(id)
    }
  }
  return { spacing, overlap }
}
