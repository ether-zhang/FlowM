/**
 * Pure layered auto-layout for shapes the model created WITHOUT coordinates — the framework
 * places them from their connections alone (the model gives shape + text + ref + connect +
 * declare_structure, not pixels). Library-agnostic on purpose: it knows only ids, sizes and
 * edges; the caller (the port) owns text measurement (it supplies w/h) and the origin (it knows
 * where existing content sits). This is the longest-path layering recovered from the retired
 * CanvasPlan renderPlan — the same math that laid out v0.6's Claude diagrams cleanly — now a
 * placement HELPER inside the one operations apply, NOT a second path/contract.
 */

export interface AutoNode {
  id: string
  w: number
  h: number
}
export interface AutoEdge {
  from: string
  to: string
}
export interface Pt {
  x: number
  y: number
}

const ROW_GAP = 100 // between layers (along the flow)
const COL_GAP = 70 // between siblings within a layer (across the flow)
const REGION_GAP = 160 // between disconnected components (separate regions)

/** Longest-path layers over forward (non-back) edges — cycle-safe, contiguous (Sugiyama-ish). */
function layerize(ids: string[], edges: AutoEdge[]): Map<string, number> {
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) if (e.from !== e.to && adj.has(e.from)) adj.get(e.from)!.push(e.to)
  const color = new Map<string, 0 | 1 | 2>(ids.map((id) => [id, 0]))
  const back = new Set<string>()
  for (const root of ids) {
    if (color.get(root) !== 0) continue
    const stack: Array<{ u: string; i: number }> = [{ u: root, i: 0 }]
    color.set(root, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const kids = adj.get(top.u)!
      if (top.i < kids.length) {
        const v = kids[top.i++]
        const c = color.get(v)
        if (c === 1) back.add(`${top.u}->${v}`)
        else if (c === 0) {
          color.set(v, 1)
          stack.push({ u: v, i: 0 })
        }
      } else {
        color.set(top.u, 2)
        stack.pop()
      }
    }
  }
  const depth = new Map<string, number>(ids.map((id) => [id, 0]))
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false
    for (const e of edges) {
      if (e.from === e.to || back.has(`${e.from}->${e.to}`)) continue
      const nd = (depth.get(e.from) ?? 0) + 1
      if (nd > (depth.get(e.to) ?? 0)) {
        depth.set(e.to, nd)
        changed = true
      }
    }
    if (!changed) break
  }
  return depth
}

/** Split ids into connected components (undirected over the edges), preserving id order — so a
 *  declared/connected region's nodes stay together and separate regions are laid out apart. */
function components(ids: string[], edges: AutoEdge[]): string[][] {
  const parent = new Map(ids.map((id) => [id, id]))
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const idset = new Set(ids)
  for (const e of edges) {
    if (!idset.has(e.from) || !idset.has(e.to)) continue
    const ra = find(e.from)
    const rb = find(e.to)
    if (ra !== rb) parent.set(ra, rb)
  }
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const r = find(id)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(id)
  }
  return [...groups.values()]
}

/** Lay out ONE set as layers: down → columns flow top-to-bottom; else rows flow left-to-right. */
function layoutOne(nodes: AutoNode[], edges: AutoEdge[], origin: Pt, down: boolean): { pos: Map<string, Pt>; w: number; h: number } {
  const ids = nodes.map((n) => n.id)
  const depth = layerize(ids, edges)
  const maxDepth = Math.max(0, ...depth.values())
  const layers: AutoNode[][] = Array.from({ length: maxDepth + 1 }, () => [])
  for (const n of nodes) layers[depth.get(n.id) ?? 0].push(n)

  const cross = (n: AutoNode) => (down ? n.w : n.h)
  const along = (n: AutoNode) => (down ? n.h : n.w)
  const layerCross = layers.map((row) => row.reduce((s, n) => s + cross(n), 0) + Math.max(0, row.length - 1) * COL_GAP)
  const maxCross = Math.max(0, ...layerCross)

  const pos = new Map<string, Pt>()
  let alongPos = down ? origin.y : origin.x
  layers.forEach((row, l) => {
    const rowAlong = Math.max(0, ...row.map(along))
    let crossPos = (down ? origin.x : origin.y) + (maxCross - layerCross[l]) / 2
    for (const n of row) {
      pos.set(n.id, down ? { x: Math.round(crossPos), y: Math.round(alongPos) } : { x: Math.round(alongPos), y: Math.round(crossPos) })
      crossPos += cross(n) + COL_GAP
    }
    alongPos += rowAlong + ROW_GAP
  })
  const alongSpan = (alongPos - (down ? origin.y : origin.x)) - ROW_GAP
  return { pos, w: down ? maxCross : alongSpan, h: down ? alongSpan : maxCross }
}

/**
 * Place every coordinate-less node from its connections. Disconnected components (separate
 * regions) are laid out independently and offset along the cross axis (side by side when
 * `down`), so each region's nodes stay together and regions don't overlap. `origin` is where the
 * caller wants the block to start (e.g. to the right of existing content, or a default for an
 * empty canvas). Returns top-left points keyed by node id.
 */
export function autoLayout(nodes: AutoNode[], edges: AutoEdge[], origin: Pt, down = true): Map<string, Pt> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Map<string, Pt>()
  let cursor = down ? origin.x : origin.y // advance along the cross axis between regions
  for (const comp of components(nodes.map((n) => n.id), edges)) {
    const set = new Set(comp)
    const compNodes = comp.map((id) => byId.get(id)!).filter(Boolean)
    const compEdges = edges.filter((e) => set.has(e.from) && set.has(e.to))
    const compOrigin: Pt = down ? { x: cursor, y: origin.y } : { x: origin.x, y: cursor }
    const { pos, w, h } = layoutOne(compNodes, compEdges, compOrigin, down)
    for (const [id, p] of pos) out.set(id, p)
    cursor += (down ? w : h) + REGION_GAP
  }
  return out
}
