import type { CanvasShape, CanvasOp, OpResult } from './schema'

/**
 * The narrow interface a concrete canvas must implement. The protocol and LLM
 * layers depend only on this — never on a specific canvas library's types — so
 * the canvas (or the whole interaction backend) can be swapped without touching them.
 */
export interface CanvasPort {
  /** Read shapes. `scope: 'selection'` returns only selected shapes, falling back
   *  to all shapes when nothing is selected. `scope: 'all'` always returns all. */
  snapshot(scope: 'selection' | 'all'): CanvasShape[]
  /** Apply a batch of ops in order, resolving create-refs so later ops can target them. */
  apply(ops: CanvasOp[]): OpResult[]
  /**
   * Render the given scope to a PNG data URL (or null if empty), so the model can
   * be sent a *visual* of the canvas alongside the serialized text — letting it
   * judge intent (structured flowchart vs free-form arrangement) from how things
   * actually look, not just the shape list.
   */
  exportImage(scope: 'selection' | 'all'): Promise<string | null>
  /**
   * Serialize the entire canvas to a JSON-safe value for project persistence.
   * The shape of this value is the concrete canvas's business — the protocol and
   * persistence layers treat it as opaque and only round-trip it. This keeps
   * persistence off any specific canvas library (see [[deserialize]]).
   */
  serialize(): unknown
  /** Restore the canvas from a value previously returned by [[serialize]]. */
  deserialize(data: unknown): void
}
