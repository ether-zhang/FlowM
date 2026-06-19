import type { CanvasShape, CanvasOp, OpResult } from './schema'

/**
 * The narrow interface a concrete canvas must implement. The protocol and LLM
 * layers depend only on this — never on tldraw types directly — so the canvas
 * (or the whole interaction backend) can be swapped without touching them.
 */
export interface CanvasPort {
  /** Read shapes. `scope: 'selection'` returns only selected shapes, falling back
   *  to all shapes when nothing is selected. `scope: 'all'` always returns all. */
  snapshot(scope: 'selection' | 'all'): CanvasShape[]
  /** Apply a batch of ops in order, resolving create-refs so later ops can target them. */
  apply(ops: CanvasOp[]): OpResult[]
}
