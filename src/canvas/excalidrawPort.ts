import {
  convertToExcalidrawElements,
  exportToCanvas,
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
import { solveArrowEndpoints } from './bindingGeometry'
import { routeBoundArrow, labelBoxSize, type LayoutBox, type SpacingEdge } from './layout'
import { runPasses, type PassContext } from './layoutPasses'

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

/** Px between an arrow tip and the shape it binds to. Big enough that the tip
 *  sits clearly off the shape's border rather than on top of its stroke. */
const GAP = 8
type Pt = { x: number; y: number }

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
  const { start, end } = solveArrowEndpoints({
    start: { shape: from, focus: 0, gap: GAP },
    end: { shape: to, focus: 0, gap: GAP },
    curStart: center(from),
    curEnd: center(to),
  })
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
 * Recompute a bound arrow's endpoints from its endpoints' current positions.
 * updateScene doesn't run Excalidraw's interactive binding pipeline, so after a
 * programmatic move_shape the bound arrows keep their stale geometry — this is the
 * manual equivalent of updateBoundElements (same faithful math, see
 * bindingGeometry.ts).
 *
 * Excalidraw OWNS focus/gap and stores its own derived focus (often ≠0, aiming the
 * arrow toward a shape corner). We deliberately RESET both ends to focus=0 / gap=GAP
 * (centre-aimed) and write a matching binding, for two reasons: (1) a centre-aimed
 * endpoint lands on the middle of an edge, far from rounded corners, where our
 * outline math is exact — honouring a corner-ward focus would route the tip onto the
 * rounded corner where our straight-edge approximation is off by many px; (2) focus
 * is not re-derived on a plain move/nudge, so writing focus=0 makes the next native
 * recompute also aim at centre and reproduce our geometry → no jump. A free end keeps
 * its current point. Collapses any manual mid-bend to a straight line (fine for moves).
 */
function reflowArrow(a: ExcalidrawArrowElement, lookup: Map<string, ExcalidrawElement>): ExcalidrawElement {
  const startEl = a.startBinding ? lookup.get(a.startBinding.elementId) : undefined
  const endEl = a.endBinding ? lookup.get(a.endBinding.elementId) : undefined
  if (!startEl && !endEl) return a
  const last = a.points[a.points.length - 1]
  const startFree = { x: a.x, y: a.y }
  const endFree = { x: a.x + last[0], y: a.y + last[1] }
  const { start, end } = solveArrowEndpoints({
    start: startEl ? { shape: startEl, focus: 0, gap: GAP } : undefined,
    end: endEl ? { shape: endEl, focus: 0, gap: GAP } : undefined,
    curStart: startEl ? center(startEl) : startFree,
    curEnd: endEl ? center(endEl) : endFree,
  })
  return newElementWith(a, {
    x: start.x,
    y: start.y,
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ] as ExcalidrawArrowElement['points'],
    // Reset the bindings to match the centre-aimed geometry we just wrote, so the
    // native pipeline reproduces it instead of snapping back to a stored corner-focus.
    ...(a.startBinding ? { startBinding: { ...a.startBinding, focus: 0, gap: GAP } } : {}),
    ...(a.endBinding ? { endBinding: { ...a.endBinding, focus: 0, gap: GAP } } : {}),
  })
}

/**
 * After endpoints settle, bow a bound arrow with a single bend point when its
 * straight segment would cut through a third shape; otherwise keep it straight
 * (and undo any earlier bow). Obstacles are every box-like shape except the
 * arrow's own two endpoints. Same stance as reflowArrow — model ops own
 * bound-arrow geometry. Routing math lives in layout.ts (pure, unit-tested).
 */
function routeArrowElement(a: ExcalidrawArrowElement, lookup: Map<string, ExcalidrawElement>): ExcalidrawElement {
  const startEl = a.startBinding ? lookup.get(a.startBinding.elementId) : undefined
  const endEl = a.endBinding ? lookup.get(a.endBinding.elementId) : undefined
  if (!startEl && !endEl) return a
  const last = a.points[a.points.length - 1]
  const start = { x: a.x, y: a.y }
  const end = { x: a.x + last[0], y: a.y + last[1] }

  const obstacles: LayoutBox[] = []
  for (const el of lookup.values()) {
    if (el.type === 'arrow') continue
    if (isText(el) && el.containerId) continue // bound labels move with their container
    if (el.id === startEl?.id || el.id === endEl?.id) continue
    obstacles.push({ id: el.id, x: el.x, y: el.y, w: el.width, h: el.height, movable: false })
  }

  const r = routeBoundArrow({ startShape: startEl, endShape: endEl, start, end, obstacles, gap: GAP })
  if (!r.mid) {
    if (a.points.length === 2) return a // already straight
    return newElementWith(a, {
      x: r.start.x,
      y: r.start.y,
      points: [
        [0, 0],
        [r.end.x - r.start.x, r.end.y - r.start.y],
      ] as ExcalidrawArrowElement['points'],
      roundness: null,
    })
  }
  return newElementWith(a, {
    x: r.start.x,
    y: r.start.y,
    points: [
      [0, 0],
      [r.mid.x - r.start.x, r.mid.y - r.start.y],
      [r.end.x - r.start.x, r.end.y - r.start.y],
    ] as ExcalidrawArrowElement['points'],
    roundness: { type: 2 }, // proportional radius → smooth curve through the bend
  })
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
      const movedIds = new Set<string>() // shapes moved this batch → reflow their bound arrows
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
            // Grow the box to fit its label (model defaults are often too narrow, so
            // text wraps); never shrink below what the model asked for.
            const text = op.text ? decodeText(op.text) : undefined
            let width = op.w
            let height = op.h
            if (text) {
              const fit = labelBoxSize(text, geo)
              width = Math.max(op.w, fit.w)
              height = Math.max(op.h, fit.h)
            }
            // Grow around the box's CENTRE, not its top-left — top-left growth drifts
            // every centre by a different amount and breaks the alignment the model set.
            const gx = op.x + (op.w - width) / 2
            const gy = op.y + (op.h - height) / 2
            skeleton.push({
              type: geo,
              id,
              x: gx,
              y: gy,
              width,
              height,
              ...(text ? { label: { text } } : {}),
            } as ExcalidrawElementSkeleton)
            if (op.ref) refs.set(op.ref, id)
            pending.set(id, { x: gx, y: gy, width, height })
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
            movedIds.add(el.id)
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
      const createdIds = new Set(created.map((e) => e.id))

      // Single source of truth for this batch's scene; arrows are added below.
      const combined = new Map<string, ExcalidrawElement>()
      for (const el of byId.values()) combined.set(el.id, el)
      for (const el of created) combined.set(el.id, el as ExcalidrawElement)

      // Create each arrow now that all endpoint shapes exist in `combined`. When
      // both ends are bindable shapes, bind them (the converter computes correct
      // focus/gap); otherwise draw a plain arrow.
      const createdArrowIds = new Set<string>()
      for (const { id, from, to, text } of connects) {
        createdArrowIds.add(id)
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

      // updateScene bypasses Excalidraw's binding/layout pipeline, so when this batch
      // touched any geometry we run our own post-process pipeline (layoutPasses.ts):
      // even spacing on fresh diagrams → clean leftover overlaps → reflow/route arrows.
      // The passes and their order are library-agnostic; the port just supplies the
      // Excalidraw-aware PassContext below. New post-process steps (e.g. colouring) join
      // as another LayoutPass without touching this orchestration.
      if (movedIds.size > 0 || createdIds.size > 0 || createdArrowIds.size > 0) {
        // Only shapes created/moved this batch may be repositioned; pre-existing shapes
        // are pinned so we never shuffle untouched content.
        const movable = new Set<string>([...createdIds, ...movedIds])
        const displaced = new Set<string>(movedIds)
        const ctx: PassContext = {
          createdCount: createdIds.size,
          // Boxes (geo + standalone text); bound labels follow their container.
          boxes: () => {
            const out: LayoutBox[] = []
            for (const el of combined.values()) {
              if (el.type === 'arrow') continue
              if (isText(el) && el.containerId) continue
              out.push({ id: el.id, x: el.x, y: el.y, w: el.width, h: el.height, movable: movable.has(el.id) })
            }
            return out
          },
          // Bound-arrow connections + label sizes (labeled diagonal edges get a wider gap).
          edges: () => {
            const labelByArrow = new Map<string, { w: number; h: number }>()
            for (const el of combined.values()) {
              if (isText(el) && el.containerId) labelByArrow.set(el.containerId, { w: el.width, h: el.height })
            }
            const out: SpacingEdge[] = []
            for (const el of combined.values()) {
              if (el.type !== 'arrow') continue
              const a = el as ExcalidrawArrowElement
              if (!a.startBinding || !a.endBinding) continue
              const lbl = labelByArrow.get(a.id)
              out.push({ from: a.startBinding.elementId, to: a.endBinding.elementId, labelW: lbl?.w, labelH: lbl?.h })
            }
            return out
          },
          applyMoves: (moves) => {
            for (const [id, p] of moves) {
              const el = combined.get(id)
              if (!el) continue
              const dx = p.x - el.x
              const dy = p.y - el.y
              combined.set(id, newElementWith(el, { x: p.x, y: p.y }))
              for (const t of combined.values()) {
                if (isText(t) && t.containerId === id) combined.set(t.id, newElementWith(t, { x: t.x + dx, y: t.y + dy }))
              }
              displaced.add(id)
            }
          },
          // Arrows touching a displaced shape (and every arrow created this batch).
          arrowsToUpdate: () => {
            const out: string[] = []
            for (const el of combined.values()) {
              if (el.type !== 'arrow') continue
              const a = el as ExcalidrawArrowElement
              if (
                createdArrowIds.has(a.id) ||
                (a.startBinding && displaced.has(a.startBinding.elementId)) ||
                (a.endBinding && displaced.has(a.endBinding.elementId))
              )
                out.push(a.id)
            }
            return out
          },
          // Straight edge-to-edge endpoints, then bow around any obstacle.
          updateArrow: (id) => {
            const el = combined.get(id)
            if (!el || el.type !== 'arrow') return
            const straight = reflowArrow(el as ExcalidrawArrowElement, combined) as ExcalidrawArrowElement
            combined.set(id, routeArrowElement(straight, combined))
          },
        }
        runPasses(ctx)
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

    async exportImage(scope) {
      const all = getNonDeletedElements(api.getSceneElements())
      const selected = api.getAppState().selectedElementIds
      const useSelection = scope === 'selection' && Object.keys(selected).length > 0
      // Include bound text labels of selected containers so labels aren't dropped.
      const elements = useSelection
        ? all.filter((el) => selected[el.id] || (isText(el) && el.containerId && selected[el.containerId]))
        : all
      if (elements.length === 0) return null

      try {
        const canvas = await exportToCanvas({
          elements,
          files: api.getFiles(),
          exportPadding: 16,
          maxWidthOrHeight: 1280, // cap so the data URL stays a reasonable token cost
          appState: { exportBackground: true, viewBackgroundColor: '#ffffff' },
        })
        return canvas.toDataURL('image/png')
      } catch {
        return null // degrade to text-only rather than break the send
      }
    },
  }
}
