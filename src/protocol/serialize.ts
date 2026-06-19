import type { CanvasShape } from './schema'

/** Round to keep the serialized context compact. */
const r = (n: number) => Math.round(n)

/**
 * Format canvas shapes into a compact, model-friendly text block.
 * Pure function — easy to unit test and independent of any canvas library.
 */
export function formatCanvas(shapes: CanvasShape[]): string {
  if (shapes.length === 0) return '(canvas is empty)'
  const lines = shapes.map((s) => {
    const parts = [`#${s.id}`, s.type, `@(${r(s.x)},${r(s.y)})`]
    if (s.w != null && s.h != null) parts.push(`${r(s.w)}x${r(s.h)}`)
    if (s.text) parts.push(`text=${JSON.stringify(s.text)}`)
    return '- ' + parts.join(' ')
  })
  return lines.join('\n')
}
