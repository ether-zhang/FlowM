import type { CanvasShape } from './schema'
import { clusterDrawRegions } from './regions'

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
  // Each cluster of nearby strokes folds to one "hand-drawn region [Bn]" line (the blue
  // chips on the image carry the same Bn). The user drew it; the model reads the figure
  // from the IMAGE and points at the whole region by its Bn handle.
  for (const reg of clusterDrawRegions(draws)) {
    const n = reg.members.length
    lines.push(
      `- [${reg.label}] hand-drawn region @(${r(reg.x)},${r(reg.y)}) ${r(reg.w)}x${r(reg.h)} — ${n} freehand stroke${n > 1 ? 's' : ''}; READ IT FROM THE IMAGE (the user's sketch — one figure, not separate shapes)`,
    )
  }
  return lines.join('\n')
}
