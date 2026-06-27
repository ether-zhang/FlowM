import type { CanvasShape, CanvasOp, OpResult } from './schema'
import type { LayoutScope } from './structure'

/**
 * The narrow interface a concrete canvas must implement. The protocol and LLM
 * layers depend only on this — never on a specific canvas library's types — so
 * the canvas (or the whole interaction backend) can be swapped without touching them.
 */
export interface CanvasPort {
  /** Read shapes. `scope: 'selection'` returns only selected shapes, falling back
   *  to all shapes when nothing is selected. `scope: 'all'` always returns all.
   *  When `ids` is given it overrides scope: exactly the shapes with those ids
   *  (used by the review gate to look at only what the model just created/changed). */
  /** Resolves once the canvas fonts are loaded. The LLM layer awaits this before drawing
   *  so text is never measured against a fallback metric (which renders clipped until the
   *  element is nudged). Optional — a port without async fonts can omit it. */
  whenReady?(): Promise<void>
  snapshot(scope: 'selection' | 'all', ids?: ReadonlySet<string>): CanvasShape[]
  /** Ids of the current selection REGION (every shape within the selected shapes'
   *  bounding box), or null when nothing is selected. The LLM layer captures this at
   *  request time so the review image can show the model's new work in the context of
   *  what the user actually selected (not just the new shapes in isolation). */
  selectionScope(): ReadonlySet<string> | null
  /**
   * Apply a batch of ops in order, resolving create-refs so later ops can target them.
   * `scope` (from the gate's structure declarations) limits which nodes the intent
   * passes may move; omit it (pre-gate / no declarations) to keep today's global B.
   */
  apply(ops: CanvasOp[], scope?: LayoutScope | null): Promise<OpResult[]>
  /**
   * Render the given scope to a PNG data URL (or null if empty), so the model can
   * be sent a *visual* of the canvas alongside the serialized text — letting it
   * judge intent (structured flowchart vs free-form arrangement) from how things
   * actually look, not just the shape list. When `marks` is given (id → mark number),
   * each shape is tagged with its number on the image (set-of-mark), so the model can
   * ground what it sees to specific ids — the same number prefixes the shape's text line.
   * When `ids` is given it overrides scope: only those shapes (plus their bound labels)
   * are rendered — the review gate uses this to show just what the model just changed.
   */
  exportImage(scope: 'selection' | 'all', marks?: Map<string, number>, ids?: ReadonlySet<string>): Promise<string | null>
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
