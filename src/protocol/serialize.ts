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
  const lines = shapes.map((s) => {
    const mark = marks?.get(s.id)
    const head = mark != null ? `[${mark}] ` : ''
    const parts = [`#${s.id}`, s.type, `@(${r(s.x)},${r(s.y)})`]
    if (s.w != null && s.h != null) parts.push(`${r(s.w)}x${r(s.h)}`)
    if (s.from || s.to) parts.push(`${s.from ?? '?'}→${s.to ?? '?'}`)
    if (s.text) parts.push(`text=${JSON.stringify(s.text)}`)
    return '- ' + head + parts.join(' ')
  })
  return lines.join('\n')
}
