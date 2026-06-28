import type { CanvasShape } from './schema'

/**
 * Group freedraw strokes into "hand-drawn regions" by proximity. A hand-drawn figure is
 * many pen-lift strokes that are individually meaningless; we cluster the ones that sit
 * near each other into one region so the model sees "a sketch here" (one blue [Bn] handle)
 * rather than N stray strokes. Pure + library-agnostic so it's shared by the text
 * serializer (region lines) and the image overlay (blue chips) — same input → same
 * deterministic clustering and labels, so [B1] in the text is [B1] in the picture.
 *
 * Regions are EPHEMERAL: recomputed each turn, labelled B1.. in reading order (top-left
 * first). They're a per-turn handle for the model to point at / (later) move a sketch as
 * a unit — not a persisted id.
 */
export interface DrawRegion {
  /** Per-turn handle, e.g. "B1". */
  label: string
  x: number
  y: number
  w: number
  h: number
  /** Ids of the member strokes (kept so a later op can move the whole region). */
  members: string[]
}

/** Strokes whose bounding boxes sit within this many px of each other join one region. */
const GAP = 48

const x2 = (s: CanvasShape) => s.x + (s.w ?? 0)
const y2 = (s: CanvasShape) => s.y + (s.h ?? 0)

/** Are a and b within GAP px of each other (bbox to bbox)? */
function near(a: CanvasShape, b: CanvasShape, gap: number): boolean {
  return !(x2(a) + gap < b.x || x2(b) + gap < a.x || y2(a) + gap < b.y || y2(b) + gap < a.y)
}

/** Cluster freedraw strokes into proximity regions, labelled B1.. in reading order. */
export function clusterDrawRegions(draws: CanvasShape[]): DrawRegion[] {
  // Union-find over stroke indices, joining any pair that sits within GAP.
  const parent = draws.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  for (let i = 0; i < draws.length; i++) {
    for (let j = i + 1; j < draws.length; j++) {
      if (near(draws[i], draws[j], GAP)) parent[find(i)] = find(j)
    }
  }

  const groups = new Map<number, number[]>()
  draws.forEach((_, i) => {
    const root = find(i)
    const g = groups.get(root)
    if (g) g.push(i)
    else groups.set(root, [i])
  })

  const regions = [...groups.values()].map((idxs) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const members: string[] = []
    for (const i of idxs) {
      const s = draws[i]
      members.push(s.id)
      minX = Math.min(minX, s.x)
      minY = Math.min(minY, s.y)
      maxX = Math.max(maxX, x2(s))
      maxY = Math.max(maxY, y2(s))
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, members }
  })
  // Reading order (top-left first) so labels are stable for a given layout.
  regions.sort((a, b) => a.y - b.y || a.x - b.x)
  return regions.map((reg, i) => ({ label: `B${i + 1}`, ...reg }))
}
