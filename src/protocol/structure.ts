import { z } from 'zod'

/**
 * Structure declarations — how the model states the intended layout structure of a
 * region after seeing the first image (see docs/structure-schema.md). The framework
 * realises each relation precisely (the B / intent passes, scoped to its nodes); nodes
 * in no relation are frozen. This module is the pure, library-agnostic schema + parser;
 * resolving the mark numbers to real shape ids happens at the gate (it needs the marks
 * map), and turning relations into per-pass scopes happens in the layout layer.
 */

/** A set-of-mark number the model sees on a node (1-based; see conversation marks). */
const Mark = z.number().int().positive()

export const StructureRelation = z.discriminatedUnion('kind', [
  // Flow chain: nodes advance down a single column (or right a row) — even spacing + axis snap.
  z.object({ kind: z.literal('flow'), nodes: z.array(Mark).min(2), dir: z.enum(['down', 'right']).optional() }),
  // Align on a shared axis: 'col' = same x (a column), 'row' = same y (a row).
  z.object({
    kind: z.literal('align'),
    nodes: z.array(Mark).min(2),
    axis: z.enum(['col', 'row']),
    at: z.enum(['min', 'center', 'max']).optional(),
  }),
  // Uniform grid, row-major; rows are implied by count / cols.
  z.object({ kind: z.literal('grid'), nodes: z.array(Mark).min(1), cols: z.number().int().positive(), gap: z.number().optional() }),
  // Nesting: children live inside parent (parent grows; children kept within).
  z.object({ kind: z.literal('contain'), parent: Mark, children: z.array(Mark).min(1) }),
  // These must not overlap (scoped de-overlap).
  z.object({ kind: z.literal('nonOverlap'), nodes: z.array(Mark).min(2) }),
  // Leave exactly as placed (hand-drawn / sketch, or to veto an inferred relation).
  z.object({ kind: z.literal('freeze'), nodes: z.array(Mark).min(1) }),
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
 * whether a mark refers to a real node is checked at the gate, where the marks are known.
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
