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
import type { CanvasPort, CanvasShape, CanvasOp, OpResult, LayoutScope } from '../protocol'
import { solveArrowEndpoints } from './bindingGeometry'
import { routeBoundArrow, labelBoxSize, fitFontSize, assignParallelOffsets, assignPortFocus, bowedEdges, type LayoutBox, type SpacingEdge, type PairedEdge, type PortFocus } from './layout'
import { runPasses, INVARIANT_PASSES, INTENT_PASSES, type PassContext } from './layoutPasses'

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

/**
 * Ids of every shape lying within the bounding box of the currently-selected shapes —
 * the "selection region", not just the selected shapes themselves. The image/list are
 * for spatial understanding, so showing the region's whole contents (a sub-flow's parent,
 * a neighbour it must not collide with) lets the model place and judge things in context.
 * Returns null when nothing is selected, so callers fall back to the whole canvas.
 * Bound labels are excluded (they follow their container).
 */
function selectionRegion(
  all: readonly ExcalidrawElement[],
  selected: Record<string, boolean>,
): Set<string> | null {
  const sel = all.filter((el) => selected[el.id])
  if (sel.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of sel) {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.width)
    maxY = Math.max(maxY, el.y + el.height)
  }
  const ids = new Set<string>()
  for (const el of all) {
    if (isText(el) && el.containerId) continue
    if (el.x <= maxX && el.x + el.width >= minX && el.y <= maxY && el.y + el.height >= minY) ids.add(el.id)
  }
  return ids
}
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

/**
 * Build ephemeral "set-of-mark" chip elements: a small high-contrast labelled square
 * pinned to each marked shape's top-left corner, showing its mark number. Returned as
 * ordinary Excalidraw elements in page space so the export pipeline positions them
 * correctly; the caller appends them to the export only (never to the live scene).
 * Arrows are skipped — marks ground NODES, which is what structure declarations key on.
 */
function buildMarkElements(elements: readonly ExcalidrawElement[], marks: Map<string, number>): ExcalidrawElement[] {
  const skeleton: ExcalidrawElementSkeleton[] = []
  for (const el of elements) {
    const n = marks.get(el.id)
    if (n == null || el.type === 'arrow') continue
    skeleton.push({
      type: 'rectangle',
      x: el.x,
      y: el.y,
      width: 30,
      height: 24,
      backgroundColor: '#ffec99',
      strokeColor: '#e8590c',
      fillStyle: 'solid',
      strokeWidth: 1,
      roundness: null,
      label: { text: String(n), fontSize: 16, strokeColor: '#c92a2a' },
    } as ExcalidrawElementSkeleton)
  }
  return skeleton.length
    ? (convertToExcalidrawElements(skeleton, { regenerateIds: true }) as ExcalidrawElement[])
    : []
}

/**
 * Proactively load the canvas fonts Excalidraw measures text with (the hand-drawn
 * Excalifont, plus Xiaolai for CJK fallback). When a labeled shape is added via
 * updateScene before its font has loaded, Excalidraw measures and line-wraps the
 * text with a fallback font, then renders it with the real (wider) one — so the
 * text overflows its box and is clipped until a click forces a remeasure. Excalidraw
 * only auto-remeasures on a font-load *transition*, which never fires for a font that
 * loaded earlier for the UI. We load them once when the editor mounts; the model
 * round-trip before any generated text dwarfs this local fetch, so by apply() time
 * the fonts are ready and the very first measurement is correct.
 */
function ensureCanvasFonts(): void {
  if (typeof document === 'undefined' || !document.fonts) return
  for (const family of ['Excalifont', 'Xiaolai']) {
    document.fonts.load(`20px "${family}"`).catch(() => {})
  }
}

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
 * Excalidraw OWNS focus/gap and stores its own derived focus. We write the focus
 * OURSELVES: by default 0 (centre-aimed) so the endpoint lands at the middle of an
 * edge, far from rounded corners where our outline math is exact; but when a shape
 * carries several arrows crowding one side, the caller passes a small assigned
 * `focus` per end (see assignPortFocus) to fan their contact points apart. Either
 * way we (a) solve the endpoint with that exact focus and (b) write the same focus
 * into the binding, so the value isn't re-derived on a plain move/nudge and the next
 * native recompute reproduces our geometry → no jump. A free end keeps its current
 * point. Collapses any manual mid-bend to a straight line (fine for moves).
 */
function reflowArrow(
  a: ExcalidrawArrowElement,
  lookup: Map<string, ExcalidrawElement>,
  focus: PortFocus = { start: 0, end: 0 },
): ExcalidrawElement {
  const startEl = a.startBinding ? lookup.get(a.startBinding.elementId) : undefined
  const endEl = a.endBinding ? lookup.get(a.endBinding.elementId) : undefined
  if (!startEl && !endEl) return a
  const last = a.points[a.points.length - 1]
  const startFree = { x: a.x, y: a.y }
  const endFree = { x: a.x + last[0], y: a.y + last[1] }
  const { start, end } = solveArrowEndpoints({
    start: startEl ? { shape: startEl, focus: focus.start, gap: GAP } : undefined,
    end: endEl ? { shape: endEl, focus: focus.end, gap: GAP } : undefined,
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
    // Write the bindings to match the focus we just solved with, so the native
    // pipeline reproduces this geometry instead of snapping back to a stored focus.
    ...(a.startBinding ? { startBinding: { ...a.startBinding, focus: focus.start, gap: GAP } } : {}),
    ...(a.endBinding ? { endBinding: { ...a.endBinding, focus: focus.end, gap: GAP } } : {}),
  })
}

/**
 * After endpoints settle, bow a bound arrow with a single bend point when its
 * straight segment would cut through a third shape; otherwise keep it straight
 * (and undo any earlier bow). Obstacles are every box-like shape except the
 * arrow's own two endpoints. Same stance as reflowArrow — model ops own
 * bound-arrow geometry. Routing math lives in layout.ts (pure, unit-tested).
 */
function routeArrowElement(
  a: ExcalidrawArrowElement,
  lookup: Map<string, ExcalidrawElement>,
  offset = 0,
  focus: PortFocus = { start: 0, end: 0 },
): ExcalidrawElement {
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

  const r = routeBoundArrow({ startShape: startEl, endShape: endEl, start, end, obstacles, gap: GAP, offset, startFocus: focus.start, endFocus: focus.end })
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
  // Warm the canvas fonts so the first labeled shape is measured with the real font
  // (not a fallback) and never renders clipped until clicked. See ensureCanvasFonts.
  ensureCanvasFonts()
  return {
    selectionScope() {
      const all = getNonDeletedElements(api.getSceneElements())
      return selectionRegion(all, api.getAppState().selectedElementIds)
    },

    snapshot(scope, ids) {
      const all = getNonDeletedElements(api.getSceneElements())
      const selected = api.getAppState().selectedElementIds
      // Explicit ids win; else a selection means its whole region; else the whole canvas.
      const keep = ids ?? (scope === 'selection' ? selectionRegion(all, selected) : null)

      // A labeled container stores its text as a separate child element
      // (containerId === container.id). Fold those into the container's `text`
      // and don't surface them as standalone shapes — mirrors the old behavior.
      const labelByContainer = new Map<string, string>()
      for (const el of all) {
        if (isText(el) && el.containerId) labelByContainer.set(el.containerId, el.text)
      }

      return all
        .filter((el) => !(isText(el) && el.containerId)) // drop bound labels
        .filter((el) => (keep ? keep.has(el.id) : true))
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

    apply(ops: CanvasOp[], scope: LayoutScope | null = null): OpResult[] {
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
            const text = op.text ? decodeText(op.text) : undefined
            // Box size is the model's INTENT: a dimension it gave is frozen; only an OMITTED
            // dimension is filled with a label-fitted default. Then the TEXT is scaled to fit
            // the box (fitFontSize) — we never grow the box past the model's size, so a
            // deliberately tight layout (tiled cells, whitepaper headers) keeps its bounds
            // instead of bursting across its neighbours. A label-sized box keeps full size.
            const fit = text ? labelBoxSize(text, geo) : { w: 120, h: 80 }
            const width = op.w ?? fit.w
            const height = op.h ?? fit.h
            skeleton.push({
              type: geo,
              id,
              x: op.x,
              y: op.y,
              width,
              height,
              ...(text ? { label: { text, fontSize: fitFontSize(text, geo, width, height) } } : {}),
            } as ExcalidrawElementSkeleton)
            if (op.ref) refs.set(op.ref, id)
            pending.set(id, { x: op.x, y: op.y, width, height })
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
              const bad = [!from ? op.from : null, !to ? op.to : null].filter(Boolean).join(', ')
              results[i] = {
                op: op.op,
                ok: false,
                error: `unresolved endpoint(s): ${bad}. A 'ref' only resolves within the response that created the shape — to connect shapes from an earlier turn, use the real id returned by create_geo (e.g. flowm-…), not the ref.`,
              }
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
      if (movedIds.size > 0 || createdIds.size > 0 || createdArrowIds.size > 0 || scope) {
        // Shapes created/moved this batch may be repositioned; with a structure scope the
        // declared nodes may move too (the model authorised laying them out), even if they
        // were created on an earlier turn. Everything else stays pinned.
        const movable = new Set<string>([...createdIds, ...movedIds])
        if (scope) for (const id of [...scope.spacing, ...scope.overlap]) movable.add(id)
        const displaced = new Set<string>(movedIds)
        // Spread arrows that share an endpoint pair (parallel/antiparallel) so they and
        // their labels don't overlap. Bindings don't move, so compute this once.
        const boundEdges: PairedEdge[] = []
        for (const el of combined.values()) {
          if (el.type !== 'arrow') continue
          const ar = el as ExcalidrawArrowElement
          if (ar.startBinding && ar.endBinding) boundEdges.push({ id: ar.id, from: ar.startBinding.elementId, to: ar.endBinding.elementId })
        }
        const arrowOffsets = assignParallelOffsets(boundEdges)
        // Fan apart arrows that crowd one side of a shape (different pairs sharing a
        // node) by assigning each end a small binding focus. Centre lookup spans the
        // whole scene so a new arrow re-fans the side's pre-existing arrows too. Edges
        // that will be bowed around an obstacle separate on their own, so exclude them
        // (else a back-edge looping past a node would slant that node's clean edges).
        const portBoxes: LayoutBox[] = []
        for (const el of combined.values()) {
          if (el.type === 'arrow') continue
          if (isText(el) && el.containerId) continue
          portBoxes.push({ id: el.id, x: el.x, y: el.y, w: el.width, h: el.height, movable: false })
        }
        const skip = bowedEdges(boundEdges, portBoxes)
        const portFocus = assignPortFocus(
          boundEdges,
          (id) => {
            const el = combined.get(id)
            return el ? center(el) : undefined
          },
          { skip },
        )
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
          // The gate's structure scope limits which nodes the B passes may move; null
          // (no declarations) keeps them global, i.e. today's behaviour.
          structure: () => scope,
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
          // Arrows created this batch, touching a displaced shape, or assigned a port
          // focus (so an existing arrow re-fans when a new sibling crowds its side).
          arrowsToUpdate: () => {
            const out: string[] = []
            for (const el of combined.values()) {
              if (el.type !== 'arrow') continue
              const a = el as ExcalidrawArrowElement
              const f = portFocus.get(a.id)
              if (
                createdArrowIds.has(a.id) ||
                (a.startBinding && displaced.has(a.startBinding.elementId)) ||
                (a.endBinding && displaced.has(a.endBinding.elementId)) ||
                (f && (f.start !== 0 || f.end !== 0))
              )
                out.push(a.id)
            }
            return out
          },
          // Straight edge-to-edge endpoints, then bow (around obstacles, or by the
          // same-pair offset so parallel/antiparallel edges don't overlap).
          updateArrow: (id) => {
            const el = combined.get(id)
            if (!el || el.type !== 'arrow') return
            const focus = portFocus.get(id) ?? { start: 0, end: 0 }
            const straight = reflowArrow(el as ExcalidrawArrowElement, combined, focus) as ExcalidrawArrowElement
            combined.set(id, routeArrowElement(straight, combined, arrowOffsets.get(id) ?? 0, focus))
          },
        }
        // Intent passes (B) move nodes only where the model declared structure — never
        // un-scoped, so the first image (build phase, scope=null) and any free-form region
        // are left exactly as placed. Invariant passes (A) always run so arrows stay bound.
        if (scope) runPasses(ctx, INTENT_PASSES)
        runPasses(ctx, INVARIANT_PASSES)
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

    async exportImage(scope, marks, ids) {
      const all = getNonDeletedElements(api.getSceneElements())
      const selected = api.getAppState().selectedElementIds
      // Explicit ids win; else a selection means its whole region; else the whole canvas.
      const keep = ids ?? (scope === 'selection' ? selectionRegion(all, selected) : null)
      // Include bound text labels (of kept containers) so labels aren't dropped.
      const elements = keep
        ? all.filter((el) => keep.has(el.id) || (isText(el) && el.containerId && keep.has(el.containerId)))
        : all
      if (elements.length === 0) return null

      // Set-of-mark: overlay each shape's mark number as ephemeral chip elements so the
      // model can ground image regions to specific ids (the same number prefixes the
      // shape's text line). Rendered as real elements in page space, so Excalidraw's
      // export handles the page→pixel transform — no manual maths, exact alignment.
      // These never touch the live scene; they exist only for this export.
      const overlay = marks ? buildMarkElements(elements, marks) : []

      try {
        const canvas = await exportToCanvas({
          elements: [...elements, ...overlay],
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
