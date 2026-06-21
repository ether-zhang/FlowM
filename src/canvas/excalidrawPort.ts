import {
  convertToExcalidrawElements,
  getNonDeletedElements,
  newElementWith,
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type {
  ExcalidrawElement,
  ExcalidrawArrowElement,
  ExcalidrawTextElement,
} from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform'
import type { CanvasPort, CanvasShape, CanvasOp, OpResult } from '../protocol'

/** Map an Excalidraw element type to the protocol's CanvasShape.type. */
function shapeType(el: ExcalidrawElement): CanvasShape['type'] {
  switch (el.type) {
    case 'rectangle':
    case 'ellipse':
    case 'diamond':
      return el.type
    case 'arrow':
      return 'arrow'
    case 'freedraw':
      return 'draw'
    case 'text':
      return 'text'
    default:
      // Excalidraw has no triangle primitive; lines/images/frames fold to 'other'.
      return 'other'
  }
}

const isText = (el: ExcalidrawElement): el is ExcalidrawTextElement => el.type === 'text'
const center = (el: { x: number; y: number; width: number; height: number }) => ({
  x: el.x + el.width / 2,
  y: el.y + el.height / 2,
})
const newId = () => `flowm-${crypto.randomUUID()}`

/**
 * Interpret literal escape sequences the model sometimes emits in text values.
 * When the model over-escapes a newline as "\\n" in its JSON tool arguments, it
 * parses to the two characters backslash+n and renders literally on the canvas
 * instead of breaking the line. Convert those (and \r, \t) to the real chars.
 * Real newline characters don't match these patterns, so this is a no-op on them.
 */
const decodeText = (s: string) => s.replace(/\\r\\n|\\r|\\n/g, '\n').replace(/\\t/g, '\t')

/** Excalidraw element types an arrow can bind to. */
const BINDABLE = new Set(['rectangle', 'ellipse', 'diamond'])

/** Register an arrow in a shape's boundElements so moving the shape moves the arrow. */
function withBoundArrow(el: ExcalidrawElement, arrowId: string): ExcalidrawElement {
  const bound = el.boundElements ?? []
  if (bound.some((b) => b.id === arrowId)) return el
  return newElementWith(el, { boundElements: [...bound, { id: arrowId, type: 'arrow' }] })
}

/** Px between an arrow tip and the shape it binds to. */
const GAP = 2
type Box = { x: number; y: number; width: number; height: number }
type Pt = { x: number; y: number }

/**
 * Point where the ray from `box`'s center toward `toward` exits the box, pushed
 * GAP px further out. Approximating ellipse/diamond by their bounding rectangle
 * is close enough — the binding's focus/gap let Excalidraw refine on first edit.
 */
function edgePoint(box: Box, toward: Pt): Pt {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const t =
    Math.min(ux ? box.width / 2 / Math.abs(ux) : Infinity, uy ? box.height / 2 / Math.abs(uy) : Infinity) + GAP
  return { x: cx + ux * t, y: cy + uy * t }
}

/**
 * Re-origin a linear element so points[0] = [0,0] (shifting the offset into x/y).
 * The converter re-origins arrows with negative extent (pointing up/left) to their
 * bbox top-left, which leaves points[0] ≠ [0,0]; Excalidraw's runtime then warns
 * "Linear element is not normalized" and refuses to edit (you can't bend it). This
 * is Excalidraw's own getNormalizedPoints, applied to undo that.
 */
function normalizeArrow(a: ExcalidrawArrowElement): ExcalidrawArrowElement {
  const [ox, oy] = a.points[0]
  if (ox === 0 && oy === 0) return a
  return newElementWith(a, {
    x: a.x + ox,
    y: a.y + oy,
    points: a.points.map((p) => [p[0] - ox, p[1] - oy]) as ExcalidrawArrowElement['points'],
  })
}

/** Build one arrow element (plus its bound label child, if any) via the converter. */
function buildArrow(id: string, start: Pt, end: Pt, text?: string): ExcalidrawElement[] {
  const out = convertToExcalidrawElements(
    [
      {
        type: 'arrow',
        id,
        x: start.x,
        y: start.y,
        width: end.x - start.x,
        height: end.y - start.y,
        points: [
          [0, 0],
          [end.x - start.x, end.y - start.y],
        ],
        ...(text ? { label: { text } } : {}),
      } as ExcalidrawElementSkeleton,
    ],
    { regenerateIds: false },
  ) as ExcalidrawElement[]
  return out.map((e) => (e.id === id ? normalizeArrow(e as ExcalidrawArrowElement) : e))
}

/**
 * A bound arrow between two shapes. We compute the edge-to-edge endpoints
 * ourselves and attach start/end bindings (focus 0 = aim at center) so the arrow
 * reroutes when either shape moves. We can't reuse the converter's own start/end
 * binding: it ships bound arrows with placeholder points that only resolve inside
 * Excalidraw's render pipeline (not on updateScene), which left every arrow
 * pointing right until an undo/redo forced a recompute.
 */
function computeBoundArrow(
  id: string,
  from: ExcalidrawElement,
  to: ExcalidrawElement,
  text?: string,
): ExcalidrawElement[] {
  const start = edgePoint(from, center(to))
  const end = edgePoint(to, center(from))
  return buildArrow(id, start, end, text).map((e) =>
    e.id === id
      ? newElementWith(e as ExcalidrawArrowElement, {
          startBinding: { elementId: from.id, focus: 0, gap: GAP },
          endBinding: { elementId: to.id, focus: 0, gap: GAP },
        })
      : e,
  )
}

/** Fallback for endpoints an arrow can't bind to: a plain arrow between centers. */
function computeUnboundArrow(
  id: string,
  from: ExcalidrawElement | undefined,
  to: ExcalidrawElement | undefined,
  text?: string,
): ExcalidrawElement[] {
  return buildArrow(id, from ? center(from) : { x: 0, y: 0 }, to ? center(to) : { x: 0, y: 0 }, text)
}

/**
 * Bind the protocol's CanvasPort to a live Excalidraw editor. This is the only
 * place that knows about Excalidraw types — the protocol and LLM layers stay
 * agnostic, exactly as they did behind the previous tldraw port.
 *
 * Excalidraw is scene-oriented (you hand it the whole element array via
 * updateScene) rather than imperative like tldraw, so `apply` reads the current
 * scene, mutates a working copy, and writes it back once.
 */
export function createExcalidrawPort(api: ExcalidrawImperativeAPI): CanvasPort {
  return {
    snapshot(scope) {
      const all = getNonDeletedElements(api.getSceneElements())
      const selected = api.getAppState().selectedElementIds
      const useSelection = scope === 'selection' && Object.keys(selected).length > 0

      // A labeled container stores its text as a separate child element
      // (containerId === container.id). Fold those into the container's `text`
      // and don't surface them as standalone shapes — mirrors the old behavior.
      const labelByContainer = new Map<string, string>()
      for (const el of all) {
        if (isText(el) && el.containerId) labelByContainer.set(el.containerId, el.text)
      }

      return all
        .filter((el) => !(isText(el) && el.containerId)) // drop bound labels
        .filter((el) => (useSelection ? selected[el.id] : true))
        .map((el): CanvasShape => {
          const shape: CanvasShape = {
            id: el.id,
            type: shapeType(el),
            x: el.x,
            y: el.y,
            w: el.width,
            h: el.height,
            text: isText(el) ? el.text : labelByContainer.get(el.id),
          }
          if (el.type === 'arrow') {
            const arrow = el as ExcalidrawArrowElement
            if (arrow.startBinding) shape.from = arrow.startBinding.elementId
            if (arrow.endBinding) shape.to = arrow.endBinding.elementId
          }
          return shape
        })
    },

    apply(ops: CanvasOp[]): OpResult[] {
      const byId = new Map<string, ExcalidrawElement>()
      for (const el of getNonDeletedElements(api.getSceneElements())) byId.set(el.id, el)

      const refs = new Map<string, string>() // create-ref → assigned id
      const pending = new Map<string, { x: number; y: number; width: number; height: number }>()
      const skeleton: ExcalidrawElementSkeleton[] = []
      const connects: { id: string; from: string; to: string; text?: string }[] = []
      const results: OpResult[] = new Array(ops.length)

      // Resolve an op's id/ref to a real element id (existing scene shape or a
      // shape created earlier in this same batch).
      const resolve = (key: string): string | undefined =>
        refs.get(key) ?? (byId.has(key) || pending.has(key) ? key : undefined)

      ops.forEach((op, i) => {
        switch (op.op) {
          case 'create_geo': {
            const id = newId()
            // Excalidraw has no triangle; approximate with a diamond for now.
            // TODO: render true triangles via a closed 3-point line polygon.
            const geo = op.shape === 'triangle' ? 'diamond' : op.shape
            skeleton.push({
              type: geo,
              id,
              x: op.x,
              y: op.y,
              width: op.w,
              height: op.h,
              ...(op.text ? { label: { text: decodeText(op.text) } } : {}),
            } as ExcalidrawElementSkeleton)
            if (op.ref) refs.set(op.ref, id)
            pending.set(id, { x: op.x, y: op.y, width: op.w, height: op.h })
            results[i] = { op: op.op, ok: true, id, ref: op.ref }
            break
          }
          case 'create_text': {
            const id = newId()
            skeleton.push({ type: 'text', id, x: op.x, y: op.y, text: decodeText(op.text) } as ExcalidrawElementSkeleton)
            if (op.ref) refs.set(op.ref, id)
            results[i] = { op: op.op, ok: true, id, ref: op.ref }
            break
          }
          case 'connect_shapes': {
            const from = resolve(op.from)
            const to = resolve(op.to)
            if (!from || !to) {
              results[i] = { op: op.op, ok: false, error: `unresolved ${op.from} or ${op.to}` }
              break
            }
            // Defer arrow creation to the post-convert pass: the endpoints may be
            // shapes created in this same batch (only realized after convert), and
            // binding is computed there uniformly for new and pre-existing shapes.
            const id = newId()
            connects.push({ id, from, to, text: op.text ? decodeText(op.text) : undefined })
            results[i] = { op: op.op, ok: true, id }
            break
          }
          case 'move_shape': {
            const el = byId.get(op.id)
            if (!el) {
              results[i] = { op: op.op, ok: false, error: `no shape ${op.id}` }
              break
            }
            const dx = op.x - el.x
            const dy = op.y - el.y
            byId.set(el.id, newElementWith(el, { x: op.x, y: op.y }))
            // Bound text labels carry their own coordinates — shift them too.
            for (const t of byId.values()) {
              if (isText(t) && t.containerId === el.id) {
                byId.set(t.id, newElementWith(t, { x: t.x + dx, y: t.y + dy }))
              }
            }
            results[i] = { op: op.op, ok: true, id: el.id }
            break
          }
          case 'update_text': {
            const el = byId.get(op.id)
            if (!el) {
              results[i] = { op: op.op, ok: false, error: `no shape ${op.id}` }
              break
            }
            const text = decodeText(op.text)
            if (isText(el)) {
              byId.set(el.id, newElementWith(el, { text, originalText: text }))
            } else {
              // Labeled container: update its bound text child if present.
              for (const t of byId.values()) {
                if (isText(t) && t.containerId === el.id) {
                  byId.set(t.id, newElementWith(t, { text, originalText: text }))
                  break
                }
              }
              // TODO: add a label to a container that had none (needs a new
              // bound text element + boundElements wiring).
            }
            results[i] = { op: op.op, ok: true, id: el.id }
            break
          }
          case 'delete_shape': {
            const el = byId.get(op.id)
            if (!el) {
              results[i] = { op: op.op, ok: false, error: `no shape ${op.id}` }
              break
            }
            byId.delete(el.id)
            for (const t of [...byId.values()]) {
              if (isText(t) && t.containerId === el.id) byId.delete(t.id)
            }
            results[i] = { op: op.op, ok: true, id: el.id }
            break
          }
        }
      })

      // Convert created shapes. regenerateIds:false is essential — it keeps the ids
      // we assigned (and returned in the op results) so later ops, in this or a
      // future turn, can reference the shapes. The default (true) would mint new
      // ids and silently break every connect_shapes that follows.
      const created = skeleton.length
        ? convertToExcalidrawElements(skeleton, { regenerateIds: false })
        : []

      // Single source of truth for this batch's scene; arrows are added below.
      const combined = new Map<string, ExcalidrawElement>()
      for (const el of byId.values()) combined.set(el.id, el)
      for (const el of created) combined.set(el.id, el as ExcalidrawElement)

      // Create each arrow now that all endpoint shapes exist in `combined`. When
      // both ends are bindable shapes, bind them (the converter computes correct
      // focus/gap); otherwise draw a plain arrow.
      for (const { id, from, to, text } of connects) {
        const a = combined.get(from)
        const b = combined.get(to)
        if (a && b && BINDABLE.has(a.type) && BINDABLE.has(b.type)) {
          for (const el of computeBoundArrow(id, a, b, text)) combined.set(el.id, el)
          combined.set(from, withBoundArrow(a, id))
          combined.set(to, withBoundArrow(b, id))
        } else {
          for (const el of computeUnboundArrow(id, a, b, text)) combined.set(el.id, el)
        }
      }

      api.updateScene({ elements: [...combined.values()] })
      return results
    },

    serialize() {
      // The element array round-trips losslessly; persistence treats it opaquely.
      return getNonDeletedElements(api.getSceneElements())
    },

    deserialize(data: unknown) {
      api.updateScene({ elements: (data as ExcalidrawElement[]) ?? [] })
    },
  }
}
