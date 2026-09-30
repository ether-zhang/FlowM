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
import { clusterDrawRegions, type CanvasPort, type CanvasShape, type CanvasOp, type OpResult, type LayoutScope } from '../protocol'
import { solveArrowEndpoints, solveEndpoint } from './bindingGeometry'
import { findVacantRect, labelBoxSize, fitFontSize, type LayoutBox, type PortFocus } from './layout'
import { runPasses, INVARIANT_PASSES, INTENT_PASSES, type PassContext } from './layoutPasses'
import { autoLayout, type AutoEdge } from './autoLayout'
import { arrowLabelTopLeft, routeNeedsUpdate, routePlannedArrow, routeSegments, type RoutedSegment } from './edgeRouting'
import { compileLayoutPlan, type LayoutEdgeSnapshot, type LayoutNodeSnapshot, type PlannedRouteEdge } from './layoutPlan'
import { protectLayoutMoves, remainingLayoutConflicts, type LayoutPreservation } from './layoutPreservation'
import { recordLayoutTrace, type LayoutTrace, type LayoutTraceStage } from './layoutTrace'

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
  const seeds = new Set(all.filter((el) => selected[el.id]).map((el) => el.id))
  return seeds.size === 0 ? null : regionOfIds(all, seeds)
}

/**
 * The region-expansion core: the combined bounding box of the seed shapes, then every shape whose
 * bbox intersects it (the seeds themselves always kept). Bound text labels are skipped from the scan
 * (they travel with their container). Used by selectionRegion (seeds = the selection) and the port's
 * regionOf (seeds = the review gate's new/changed shapes).
 */
function regionOfIds(all: readonly ExcalidrawElement[], seeds: ReadonlySet<string>): Set<string> {
  const seedEls = all.filter((el) => seeds.has(el.id))
  if (seedEls.length === 0) return new Set(seeds)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of seedEls) {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.width)
    maxY = Math.max(maxY, el.y + el.height)
  }
  const ids = new Set<string>(seeds)
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
const boxOf = (el: { x: number; y: number; width: number; height: number }) => ({
  x: el.x,
  y: el.y,
  w: el.width,
  h: el.height,
})
function unionBox(elements: readonly ExcalidrawElement[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of elements) {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.width)
    maxY = Math.max(maxY, el.y + el.height)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}
// Short id: the model has to copy these back verbatim when it edits an existing shape (in
// connect_shapes / edits), so keep them brief. 8 hex chars (~4.3e9) is plenty unique per scene;
// the `flowm-` prefix marks FlowM-created shapes apart from user-drawn (Excalidraw nanoid) ones.
const newId = () => `flowm-${crypto.randomUUID().slice(0, 8)}`

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
  const CHIP_W = 30
  const CHIP_H = 24
  for (const el of elements) {
    const n = marks.get(el.id)
    if (n == null || el.type === 'arrow') continue
    skeleton.push({
      type: 'rectangle',
      // Sit the chip JUST ABOVE the shape's top-left corner, not on it — placed on the
      // corner it occludes the content (small labels disappear under it entirely).
      x: el.x,
      y: el.y - CHIP_H - 2,
      width: CHIP_W,
      height: CHIP_H,
      backgroundColor: '#ffec99',
      strokeColor: '#e8590c',
      fillStyle: 'solid',
      strokeWidth: 1,
      roundness: null,
      label: { text: String(n), fontSize: 16, strokeColor: '#c92a2a' },
    } as ExcalidrawElementSkeleton)
  }
  // Blue [Bn] chips: one per hand-drawn region (a proximity cluster of freedraw strokes),
  // so the model can point at a whole sketch as a unit — distinct from the orange node chips.
  const draws: CanvasShape[] = elements
    .filter((e) => e.type === 'freedraw')
    .map((e) => ({ id: e.id, type: 'draw' as const, x: e.x, y: e.y, w: e.width, h: e.height }))
  for (const reg of clusterDrawRegions(draws)) {
    skeleton.push({
      type: 'rectangle',
      x: reg.x,
      y: reg.y - CHIP_H - 2,
      width: CHIP_W,
      height: CHIP_H,
      backgroundColor: '#a5d8ff',
      strokeColor: '#1971c2',
      fillStyle: 'solid',
      strokeWidth: 1,
      roundness: null,
      label: { text: reg.label, fontSize: 14, strokeColor: '#1971c2' },
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

function arrowDimensions(points: ExcalidrawArrowElement['points']): { width: number; height: number } {
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
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
  const points = [
    [0, 0],
    [end.x - start.x, end.y - start.y],
  ] as ExcalidrawArrowElement['points']
  return newElementWith(a, {
    x: start.x,
    y: start.y,
    points,
    ...arrowDimensions(points),
    // Write the bindings to match the focus we just solved with, so the native
    // pipeline reproduces this geometry instead of snapping back to a stored focus.
    ...(a.startBinding ? { startBinding: { ...a.startBinding, focus: focus.start, gap: GAP } } : {}),
    ...(a.endBinding ? { endBinding: { ...a.endBinding, focus: focus.end, gap: GAP } } : {}),
  })
}

/** Keep an existing route's bends; moving a whole region translates its internal routes. */
function reanchorArrow(
  arrow: ExcalidrawArrowElement,
  current: Map<string, ExcalidrawElement>,
  previous: Map<string, ExcalidrawElement>,
): ExcalidrawArrowElement {
  const startShape = arrow.startBinding && current.get(arrow.startBinding.elementId)
  const endShape = arrow.endBinding && current.get(arrow.endBinding.elementId)
  const delta = (shape: ExcalidrawElement | null | undefined): Pt => {
    const old = shape && previous.get(shape.id)
    return shape && old ? { x: shape.x - old.x, y: shape.y - old.y } : { x: 0, y: 0 }
  }
  const startDelta = delta(startShape)
  const endDelta = delta(endShape)
  if (startDelta.x === endDelta.x && startDelta.y === endDelta.y) {
    return startDelta.x || startDelta.y
      ? newElementWith(arrow, { x: arrow.x + startDelta.x, y: arrow.y + startDelta.y })
      : arrow
  }
  const points = absoluteArrowPoints(arrow)
  if (points.length === 2) {
    const endpoints = solveArrowEndpoints({
      start: startShape && arrow.startBinding ? { shape: startShape, focus: arrow.startBinding.focus, gap: arrow.startBinding.gap } : undefined,
      end: endShape && arrow.endBinding ? { shape: endShape, focus: arrow.endBinding.focus, gap: arrow.endBinding.gap } : undefined,
      curStart: points[0],
      curEnd: points[1],
    })
    points[0] = endpoints.start
    points[1] = endpoints.end
  } else {
    if (startShape && arrow.startBinding) points[0] = solveEndpoint(startShape, arrow.startBinding.focus, arrow.startBinding.gap, points[1])
    if (endShape && arrow.endBinding) points[points.length - 1] = solveEndpoint(endShape, arrow.endBinding.focus, arrow.endBinding.gap, points[points.length - 2])
  }
  const origin = points[0]
  const relative = points.map((point) => [point.x - origin.x, point.y - origin.y]) as ExcalidrawArrowElement['points']
  return newElementWith(arrow, { x: origin.x, y: origin.y, points: relative, ...arrowDimensions(relative) })
}

/** Adapt one compiled route to Excalidraw points; routing math remains pure. */
function routeArrowElement(
  a: ExcalidrawArrowElement,
  lookup: Map<string, ExcalidrawElement>,
  edge: PlannedRouteEdge,
  occupied: readonly RoutedSegment[],
  reservedLabels: readonly LayoutBox[],
  preserve: boolean,
  warnings: string[],
): ExcalidrawArrowElement {
  const startEl = a.startBinding ? lookup.get(a.startBinding.elementId) : undefined
  const endEl = a.endBinding ? lookup.get(a.endBinding.elementId) : undefined
  if (!startEl && !endEl) return a
  const last = a.points[a.points.length - 1]
  const start = { x: a.x, y: a.y }
  const end = { x: a.x + last[0], y: a.y + last[1] }

  const obstacles: LayoutBox[] = [...reservedLabels]
  const labelObstacles: LayoutBox[] = [...reservedLabels]
  const transparent = new Set(edge.transparentObstacleIds)
  for (const el of lookup.values()) {
    if (el.type === 'arrow') continue
    if (isText(el) && el.containerId) continue
    const box = { id: el.id, x: el.x, y: el.y, w: el.width, h: el.height, movable: false }
    if (transparent.has(el.id)) {
      const border = 4
      labelObstacles.push(
        { ...box, id: `${box.id}:top`, h: border },
        { ...box, id: `${box.id}:bottom`, y: box.y + box.h - border, h: border },
        { ...box, id: `${box.id}:left`, w: border },
        { ...box, id: `${box.id}:right`, x: box.x + box.w - border, w: border },
      )
    } else {
      obstacles.push(box)
      labelObstacles.push(box)
    }
  }

  const route = routePlannedArrow({
    startId: startEl?.id,
    endId: endEl?.id,
    startShape: startEl,
    endShape: endEl,
    start,
    end,
    obstacles,
    labelObstacles,
    occupied,
    label: edge.label,
    gap: GAP,
    offset: edge.offset,
    focus: preserve ? { start: a.startBinding?.focus ?? 0, end: a.endBinding?.focus ?? 0 } : edge.focus,
    preferredPoints: preserve ? absoluteArrowPoints(a) : undefined,
  })
  warnings.push(...route.warnings.map((warning) => `${edge.id}: ${warning}`))
  const origin = route.points[0]
  const points = route.points.map((point) => [point.x - origin.x, point.y - origin.y]) as ExcalidrawArrowElement['points']
  return newElementWith(a, {
    x: origin.x,
    y: origin.y,
    points,
    ...arrowDimensions(points),
    // New routes use the checked line segments exactly; preserve existing visual treatment.
    roundness: preserve && JSON.stringify(points) === JSON.stringify(a.points) ? a.roundness : null,
  })
}

/** Absolute points are required both for shared route occupancy and bound text. */
function absoluteArrowPoints(arrow: ExcalidrawArrowElement): Pt[] {
  return arrow.points.map((point) => ({ x: arrow.x + point[0], y: arrow.y + point[1] }))
}

/** Keep Excalidraw's bound text element aligned with the route written above. */
function syncArrowLabel(
  arrow: ExcalidrawArrowElement,
  edge: PlannedRouteEdge,
  lookup: Map<string, ExcalidrawElement>,
): LayoutBox | null {
  if (!edge.label) return null
  const label = lookup.get(edge.label.id)
  if (!label || !isText(label)) return null
  const pos = arrowLabelTopLeft(absoluteArrowPoints(arrow), label.width, label.height)
  const next = newElementWith(label, { x: pos.x, y: pos.y })
  lookup.set(next.id, next)
  return { id: next.id, x: next.x, y: next.y, w: next.width, h: next.height, movable: false }
}

/**
 * Positions for coordinate-less create ops. Coordinate-ful operations keep the
 * model's macro placement; pure layered placement lives in autoLayout.ts.
 */
function autoPlaceMissing(ops: CanvasOp[], existing: ExcalidrawElement[]): Map<number, { x: number; y: number }> {
  const auto: { i: number; key: string; ref?: string; w: number; h: number }[] = []
  ops.forEach((op, i) => {
    if ((op.op === 'create_geo' || op.op === 'create_text') && op.x == null && op.y == null) {
      const text = op.text ? decodeText(op.text) : undefined
      const geo = op.op === 'create_geo' ? (op.shape === 'triangle' ? 'diamond' : op.shape) : 'rectangle'
      const fit = text ? labelBoxSize(text, geo) : { w: 120, h: 80 }
      const w = (op.op === 'create_geo' ? op.w : undefined) ?? fit.w
      const h = (op.op === 'create_geo' ? op.h : undefined) ?? fit.h
      auto.push({ i, key: `a${i}`, ref: op.ref, w, h })
    }
  })
  if (auto.length === 0) return new Map()
  const refToKey = new Map<string, string>()
  for (const a of auto) if (a.ref) refToKey.set(a.ref, a.key)
  const edges: AutoEdge[] = []
  for (const op of ops) {
    if (op.op === 'connect_shapes') {
      const f = refToKey.get(op.from)
      const t = refToKey.get(op.to)
      if (f && t) edges.push({ from: f, to: t })
    }
  }
  const boxes = existing.filter((e) => e.type !== 'arrow' && !(isText(e) && e.containerId))
  let origin = { x: 120, y: 120 }
  if (boxes.length) {
    let maxX = -Infinity
    let minY = Infinity
    for (const e of boxes) {
      maxX = Math.max(maxX, e.x + e.width)
      minY = Math.min(minY, e.y)
    }
    origin = { x: maxX + 160, y: minY }
  }
  const pos = autoLayout(
    auto.map((a) => ({ id: a.key, w: a.w, h: a.h })),
    edges,
    origin,
    true,
  )
  const out = new Map<number, { x: number; y: number }>()
  for (const a of auto) {
    const p = pos.get(a.key)
    if (p) out.set(a.i, p)
  }
  return out
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
  let lastDiagnostics: string[] = []
  return {
    layoutDiagnostics: () => [...lastDiagnostics],
    selectionScope() {
      const all = getNonDeletedElements(api.getSceneElements())
      return selectionRegion(all, api.getAppState().selectedElementIds)
    },

    regionOf(ids) {
      return regionOfIds(getNonDeletedElements(api.getSceneElements()), ids)
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

    async apply(ops: CanvasOp[], scope: LayoutScope | null = null): Promise<OpResult[]> {
      lastDiagnostics = []
      const byId = new Map<string, ExcalidrawElement>()
      for (const el of getNonDeletedElements(api.getSceneElements())) byId.set(el.id, el)
      const previous = new Map(byId)
      const trace: LayoutTrace = { operations: ops, relations: scope?.relations ?? [], stages: [], diagnostics: [] }
      const snapshotStage = (
        name: LayoutTraceStage['name'],
        elements: Map<string, ExcalidrawElement>,
        details: Partial<Pick<LayoutTraceStage, 'candidate' | 'accepted' | 'issues'>> = {},
      ) => trace.stages.push(structuredClone({ name, elements: [...elements.values()], accepted: true, issues: [], ...details }))
      snapshotStage('before', byId)

      // Place any create ops the model left coordinate-less (it's trusting the framework to lay
      // them out from their connections); coordinate-ful ops keep the model's exact placement.
      const autoPos = autoPlaceMissing(ops, [...byId.values()])

      const refs = new Map<string, string>() // create-ref → assigned id
      const pending = new Map<string, { x: number; y: number; width: number; height: number }>()
      const skeleton: ExcalidrawElementSkeleton[] = []
      const connects: { id: string; from: string; to: string; text?: string }[] = []
      const movedIds = new Set<string>() // shapes moved this batch → reflow their bound arrows
      const editedArrowIds = new Set<string>()
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
            // Coordinate-less → the framework's auto-layout position; else the model's own.
            const place = autoPos.get(i)
            const x = op.x ?? place?.x ?? 0
            const y = op.y ?? place?.y ?? 0
            skeleton.push({
              type: geo,
              id,
              x,
              y,
              width,
              height,
              ...(text ? { label: { text, fontSize: fitFontSize(text, geo, width, height) } } : {}),
            } as ExcalidrawElementSkeleton)
            if (op.ref) refs.set(op.ref, id)
            pending.set(id, { x, y, width, height })
            results[i] = { op: op.op, ok: true, id, ref: op.ref }
            break
          }
          case 'create_text': {
            const id = newId()
            const place = autoPos.get(i)
            skeleton.push({ type: 'text', id, x: op.x ?? place?.x ?? 0, y: op.y ?? place?.y ?? 0, text: decodeText(op.text) } as ExcalidrawElementSkeleton)
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
          case 'place_region': {
            const moveIds = new Set(op.ids)
            const moving = op.ids
              .map((id) => byId.get(id))
              .filter((el): el is ExcalidrawElement => !!el && el.type !== 'arrow' && !(isText(el) && el.containerId))
            if (moving.length === 0) {
              results[i] = { op: op.op, ok: false, error: `no movable non-arrow shapes in ids: ${op.ids.join(', ')}` }
              break
            }

            const region = unionBox(moving)
            const anchorEl = op.anchorId ? byId.get(op.anchorId) : undefined
            const anchor = anchorEl && anchorEl.type !== 'arrow' && !(isText(anchorEl) && anchorEl.containerId) ? boxOf(anchorEl) : region
            const obstacles = [...byId.values()]
              .filter((el) => el.type !== 'arrow' && !(isText(el) && el.containerId) && !moveIds.has(el.id))
              .map((el) => ({ ...boxOf(el), id: el.id, movable: false }))
            const place = findVacantRect(region, obstacles, { prefer: op.prefer, anchor, margin: op.margin })
            const dx = place.x - region.x
            const dy = place.y - region.y

            if (dx !== 0 || dy !== 0) {
              for (const el of moving) {
                byId.set(el.id, newElementWith(el, { x: el.x + dx, y: el.y + dy }))
                movedIds.add(el.id)
              }
              for (const t of byId.values()) {
                if (isText(t) && t.containerId && moveIds.has(t.containerId)) {
                  byId.set(t.id, newElementWith(t, { x: t.x + dx, y: t.y + dy }))
                }
              }
            }
            results[i] = { op: op.op, ok: true, ids: moving.map((el) => el.id), x: place.x, y: place.y, dx, dy }
            break
          }
          case 'update_text': {
            const el = byId.get(op.id)
            if (!el) {
              results[i] = { op: op.op, ok: false, error: `no shape ${op.id}` }
              break
            }
            const text = decodeText(op.text)
            if (el.type === 'arrow') editedArrowIds.add(el.id)
            if (isText(el) && el.containerId && byId.get(el.containerId)?.type === 'arrow') editedArrowIds.add(el.containerId)
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

      // Text is measured INSIDE convertToExcalidrawElements (and the arrow-label converts
      // below): if the glyphs aren't loaded, it measures against a fallback metric and the
      // real (wider) font renders clipped until nudged. FontFaceSet.load(font, text) loads
      // exactly the subset those characters need, so await it for this batch's text BEFORE
      // converting — the very first measurement is then correct (no clip, no reflow flash).
      // (Excalidraw measures the hand-drawn family as "Excalifont", CJK via the Xiaolai
      // unicode-range faces; load is size-independent so 20px covers every rendered size.)
      const batchText = ops.map((op) => ('text' in op && typeof op.text === 'string' ? decodeText(op.text) : '')).join('')
      if (batchText && typeof document !== 'undefined' && document.fonts) {
        await Promise.all([
          document.fonts.load(`20px "Excalifont"`, batchText),
          document.fonts.load(`20px "Xiaolai"`, batchText),
        ]).catch(() => [])
      }

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

      snapshotStage('materialized', combined)

      // updateScene bypasses Excalidraw's binding/layout pipeline. Recompile after every
      // applied batch so text edits and deleted obstacles cannot leave stale edge geometry.
      if (ops.length > 0 || scope) {
        // Shapes created/moved this batch may be repositioned; with a structure scope the
        // declared nodes may move too (the model authorised laying them out), even if they
        // were created on an earlier turn. Everything else stays pinned.
        const movable = new Set<string>([...createdIds, ...movedIds])
        if (scope) for (const id of [...scope.spacing, ...scope.overlap]) movable.add(id)
        // The compiler measures the live scene. Any node move invalidates its cached
        // plan, so endpoint focus and obstacle lanes are derived only after nodes settle.
        let planCache: ReturnType<typeof compileLayoutPlan> | null = null
        const compileCurrentPlan = (preservation?: LayoutPreservation): ReturnType<typeof compileLayoutPlan> => {
          const nodes: LayoutNodeSnapshot[] = []
          const labels = new Map<string, { id: string; w: number; h: number }>()
          for (const el of combined.values()) {
            if (isText(el) && el.containerId) {
              labels.set(el.containerId, { id: el.id, w: el.width, h: el.height })
              continue
            }
            if (el.type === 'arrow') continue
            nodes.push({
              id: el.id,
              x: el.x,
              y: el.y,
              w: el.width,
              h: el.height,
              movable: movable.has(el.id),
              containerCandidate: el.type === 'rectangle' || el.type === 'frame',
              alignable: BINDABLE.has(el.type) || el.type === 'text' || el.type === 'frame',
            })
          }
          const edges: LayoutEdgeSnapshot[] = []
          for (const el of combined.values()) {
            if (el.type !== 'arrow') continue
            const arrow = el as ExcalidrawArrowElement
            if (!arrow.startBinding || !arrow.endBinding) continue
            edges.push({
              id: arrow.id,
              from: arrow.startBinding.elementId,
              to: arrow.endBinding.elementId,
              label: labels.get(arrow.id),
            })
          }
          return compileLayoutPlan({
            nodes,
            edges,
            authorization: scope,
            createdCount: createdIds.size,
            preservation,
          })
        }
        planCache = compileCurrentPlan()
        const preservation = planCache.preservation
        const routeWarnings: string[] = []

        const ctx: PassContext = {
          plan: () => (planCache ??= compileCurrentPlan(preservation)),
          applyMoves: (moves, stage) => {
            const plan = ctx.plan()
            const allowed = stage === 'spacing' ? scope?.spacing : scope?.overlap
            const nodes = plan.nodes.map((node) => ({ ...node, movable: allowed?.has(node.id) ?? false }))
            const guarded = moves.size
              ? protectLayoutMoves(nodes, moves, plan.preservation, plan.intent.spacing.edges)
              : { moves, candidate: nodes, issues: [] }
            let changed = false
            for (const [id, p] of guarded.moves) {
              const el = combined.get(id)
              if (!el || (p.x === el.x && p.y === el.y)) continue
              const dx = p.x - el.x
              const dy = p.y - el.y
              combined.set(id, newElementWith(el, { x: p.x, y: p.y }))
              for (const text of combined.values()) {
                if (isText(text) && text.containerId === id) {
                  combined.set(text.id, newElementWith(text, { x: text.x + dx, y: text.y + dy }))
                }
              }
              movedIds.add(id)
              changed = true
            }
            snapshotStage(stage, combined, { accepted: guarded.issues.length === 0, issues: guarded.issues, candidate: guarded.candidate })
            if (changed) planCache = null
          },
          routeArrows: (edges) => {
            const occupied: RoutedSegment[] = []
            const reservedLabels: LayoutBox[] = []
            const changedNodes = new Set([...createdIds, ...movedIds])
            const changedEdges = new Set([...connects.map((edge) => edge.id), ...editedArrowIds])
            const changedObstacles = ctx.plan().nodes.filter((node) => changedNodes.has(node.id))
            const affected = new Set<string>()
            for (const edge of edges) {
              const el = combined.get(edge.id) as ExcalidrawArrowElement | undefined
              if (!el) continue
              const label = edge.label && combined.get(edge.label.id)
              const labelBox = label ? { id: label.id, x: label.x, y: label.y, w: label.width, h: label.height, movable: false } : undefined
              if (routeNeedsUpdate({ ...edge, points: absoluteArrowPoints(el), label: labelBox }, changedNodes, changedEdges, changedObstacles)) {
                affected.add(edge.id)
              } else {
                occupied.push(...routeSegments(absoluteArrowPoints(el)))
                if (labelBox) reservedLabels.push(labelBox)
              }
            }
            for (const edge of edges) {
              if (!affected.has(edge.id)) continue
              const el = combined.get(edge.id)
              if (!el || el.type !== 'arrow') continue
              const preserve = previous.has(edge.id)
              const anchored = preserve
                ? reanchorArrow(el as ExcalidrawArrowElement, combined, previous)
                : reflowArrow(el as ExcalidrawArrowElement, combined, edge.focus) as ExcalidrawArrowElement
              const routed = routeArrowElement(anchored, combined, edge, occupied, reservedLabels, preserve, routeWarnings)
              combined.set(edge.id, routed)
              const labelBox = syncArrowLabel(routed, edge, combined)
              if (labelBox) reservedLabels.push(labelBox)
              occupied.push(...routeSegments(absoluteArrowPoints(routed)))
            }
            snapshotStage('routing', combined, { issues: [...routeWarnings] })
          },
        }
        // Intent passes (B) move nodes only where the model declared structure — never
        // un-scoped, so the first image (build phase, scope=null) and any free-form region
        // are left exactly as placed. Invariant passes (A) always run so arrows stay bound.
        if (scope) runPasses(ctx, INTENT_PASSES)
        runPasses(ctx, INVARIANT_PASSES)
        const finalPlan = ctx.plan()
        lastDiagnostics = [...new Set([
          ...remainingLayoutConflicts(finalPlan.nodes, finalPlan.preservation, finalPlan.intent.spacing.edges),
          ...routeWarnings,
        ])].slice(0, 20)
      }

      api.updateScene({ elements: [...combined.values()] })
      trace.diagnostics = lastDiagnostics
      recordLayoutTrace(trace)
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
