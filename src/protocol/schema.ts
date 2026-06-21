import { z } from 'zod'

/**
 * The graphical bidirectional-interaction protocol.
 *
 * This module is the heart of FlowM and is intentionally independent of any
 * particular canvas library or LLM. It defines two things:
 *   1. CanvasShape — the structured form a shape takes when serialized for the model.
 *   2. CanvasOp    — the operation primitives the model emits to mutate the canvas.
 *
 * A concrete canvas (e.g. Excalidraw) implements `CanvasPort` to bind these to a real editor.
 */

export const GeoKind = z.enum(['rectangle', 'ellipse', 'diamond', 'triangle'])
export type GeoKind = z.infer<typeof GeoKind>

/** A shape read back from the canvas and sent to the model as context. */
export const CanvasShape = z.object({
  id: z.string(),
  type: z.enum(['rectangle', 'ellipse', 'diamond', 'triangle', 'text', 'arrow', 'draw', 'other']),
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  text: z.string().optional(),
  /** For arrows: the shape ids its start/end terminals are bound to (if any). */
  from: z.string().optional(),
  to: z.string().optional(),
})
export type CanvasShape = z.infer<typeof CanvasShape>

/**
 * Operation primitives. Create ops may carry a `ref` — a temporary label the
 * model assigns so it can reference a not-yet-created shape (e.g. connect two
 * boxes it just made) within the same batch. `apply` resolves refs to real ids.
 */
export const CanvasOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create_geo'),
    shape: GeoKind,
    x: z.number(),
    y: z.number(),
    w: z.number().default(120),
    h: z.number().default(80),
    text: z.string().optional(),
    ref: z.string().optional(),
  }),
  z.object({
    op: z.literal('create_text'),
    x: z.number(),
    y: z.number(),
    text: z.string(),
    ref: z.string().optional(),
  }),
  z.object({
    op: z.literal('move_shape'),
    id: z.string(),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    op: z.literal('update_text'),
    id: z.string(),
    text: z.string(),
  }),
  z.object({
    op: z.literal('delete_shape'),
    id: z.string(),
  }),
  z.object({
    op: z.literal('connect_shapes'),
    from: z.string(),
    to: z.string(),
    text: z.string().optional(),
  }),
])
export type CanvasOp = z.infer<typeof CanvasOp>

/** Result of applying one op, returned to the model so it can chain follow-ups. */
export interface OpResult {
  op: CanvasOp['op']
  ok: boolean
  /** real id of a created shape (and the ref it was assigned, if any) */
  id?: string
  ref?: string
  error?: string
}

export function parseOp(input: unknown): CanvasOp {
  return CanvasOp.parse(input)
}
