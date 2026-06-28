import type { CanvasShape } from './schema'

/** Round to keep the serialized context compact. */
const r = (n: number) => Math.round(n)

/**
 * Format canvas shapes into a compact, model-friendly text block.
 * Pure function — easy to unit test and independent of any canvas library.
 *
 * When `marks` (id → number) is given, each line is prefixed with `[n]`, matching the
 * set-of-mark number drawn on that shape in the exported image — so the model can map
 * what it sees in the image to a specific shape (and its id) unambiguously.
 */
export function formatCanvas(shapes: CanvasShape[], marks?: Map<string, number>): string {
  if (shapes.length === 0) return '(canvas is empty)'
  // Hand-drawn (freedraw) strokes are folded into one "hand-drawn region" line (see
  // foldDrawRegion): per-stroke bboxes are pen-lift segments with no semantics, and a
  // figure made of dozens of them would drown the list and atomise what the model should
  // read as one sketch. The model interprets the sketch from the IMAGE, not these bboxes.
  const draws = shapes.filter((s) => s.type === 'draw')
  const rest = shapes.filter((s) => s.type !== 'draw')
  const lines = rest.map((s) => {
    const mark = marks?.get(s.id)
    const head = mark != null ? `[${mark}] ` : ''
    const parts = [`#${s.id}`, s.type, `@(${r(s.x)},${r(s.y)})`]
    if (s.w != null && s.h != null) parts.push(`${r(s.w)}x${r(s.h)}`)
    if (s.from || s.to) parts.push(`${s.from ?? '?'}→${s.to ?? '?'}`)
    if (s.text) parts.push(`text=${JSON.stringify(s.text)}`)
    return '- ' + head + parts.join(' ')
  })
  if (draws.length > 0) lines.push(foldDrawRegion(draws))
  return lines.join('\n')
}

/** Collapse all freedraw strokes into one region summary: union bounding box + count, with
 *  a hint to read the actual figure from the image rather than the (semantically empty)
 *  per-stroke boxes. Single region for now; split disjoint sketches by proximity later. */
function foldDrawRegion(draws: CanvasShape[]): string {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of draws) {
    minX = Math.min(minX, s.x)
    minY = Math.min(minY, s.y)
    maxX = Math.max(maxX, s.x + (s.w ?? 0))
    maxY = Math.max(maxY, s.y + (s.h ?? 0))
  }
  const n = draws.length
  return `- hand-drawn region @(${r(minX)},${r(minY)}) ${r(maxX - minX)}x${r(maxY - minY)} — ${n} freehand stroke${n > 1 ? 's' : ''} forming a sketch; READ IT FROM THE IMAGE (it's the user's drawing — interpret it as one figure, don't treat strokes as separate shapes)`
}
