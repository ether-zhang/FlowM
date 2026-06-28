import type { CanvasOp, GeoKind } from '../protocol'
import type { DiagramSpec, DiagramNode } from './diagram'

/**
 * Turn a DiagramSpec (nodes + edges, no positions) into canvas ops that draw it: a layered
 * layout (roots at the top, each node below its deepest predecessor) plus an arrow per edge.
 * Pure — depends only on protocol TYPES, never the canvas runtime — so it serves the
 * deterministic-render path now and is exactly what an incremental MCP path would call too.
 *
 * Nodes are created with `ref = node.id`; edges connect by that ref, all in ONE apply batch
 * (the port resolves same-batch refs), so positions are frozen exactly as computed here —
 * no layout pass needed and none fights it.
 */

const KIND_TO_GEO: Record<NonNullable<DiagramNode['kind']>, GeoKind> = {
  process: 'rectangle',
  decision: 'diamond',
  terminal: 'ellipse',
  data: 'rectangle',
}

const ROW_GAP = 100 // empty space between layers (along the flow axis)
const COL_GAP = 70 // empty space between siblings within a layer (across the flow axis)

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Visual width of a label in "columns": CJK / full-width glyphs count double. */
function visualLen(s: string): number {
  let n = 0
  for (const ch of s) n += /[　-鿿＀-￯⺀-〿]/.test(ch) ? 2 : 1
  return n
}

/** A content-fitted box size, mirroring how the port sizes label boxes (keeps layout == render). */
function nodeSize(node: DiagramNode): { w: number; h: number } {
  const lines = node.label.split('\n')
  const cols = Math.max(1, ...lines.map(visualLen))
  let w = clamp(cols * 10 + 32, 120, 280)
  let h = clamp(lines.length * 24 + 28, 60, 200)
  // Non-rectangular shapes inscribe text in a SMALLER area, so a label-sized rectangle would
  // clip them — enlarge to match the port's labelBoxSize (diamond ~1.8, ellipse ~1.35) so
  // fitFontSize keeps the text at full size instead of shrinking it to a 9px floor.
  if (node.kind === 'decision') {
    w *= 1.7
    h *= 1.6
  } else if (node.kind === 'terminal') {
    w *= 1.3
    h *= 1.25
  }
  return { w: Math.round(w), h: Math.round(h) }
}

/**
 * Layer (depth) per node = longest path from a root over FORWARD edges only. Real
 * structures have cycles (eviction → free-queue, touch → ref_cnt); relaxing over every
 * edge would inflate depths unboundedly (the cap stops the loop but leaves NON-contiguous
 * layers → array holes → NaN downstream). So first flag back-edges by DFS and exclude them,
 * leaving a DAG whose longest-path layers are contiguous 0..max. Roots / isolated nodes → 0.
 */
function layerize(ids: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) if (e.from !== e.to) adj.get(e.from)!.push(e.to)

  // Iterative DFS: an edge into a node currently on the stack (gray) closes a cycle → back-edge.
  const color = new Map<string, 0 | 1 | 2>(ids.map((id) => [id, 0])) // white | gray | black
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

  // Longest path over forward (non-back) edges — a DAG, so relaxation converges and the
  // resulting layers are contiguous (every depth-d node has a forward parent at d-1).
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

export function layoutDiagram(spec: DiagramSpec, origin: { x: number; y: number }): CanvasOp[] {
  const ids = new Set(spec.nodes.map((n) => n.id))
  // Edges are only layout/draw input when both ends are real nodes; drop dangling ones.
  const edges = spec.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  const down = (spec.dir ?? 'down') === 'down'

  const depth = layerize([...ids], edges)
  const size = new Map(spec.nodes.map((n) => [n.id, nodeSize(n)] as const))

  // DENSE layer buckets (Array.from fills every index → no holes → the centering maths
  // below can't spread an `undefined` into Math.max and produce NaN), spec order kept.
  const maxDepth = Math.max(0, ...depth.values())
  const layers: DiagramNode[][] = Array.from({ length: maxDepth + 1 }, () => [])
  for (const n of spec.nodes) layers[depth.get(n.id) ?? 0].push(n)

  // Cross-axis extent of each layer and the widest one, so narrow layers center under wide.
  const cross = (n: DiagramNode) => (down ? size.get(n.id)!.w : size.get(n.id)!.h)
  const along = (n: DiagramNode) => (down ? size.get(n.id)!.h : size.get(n.id)!.w)
  const layerCross = layers.map((row) => row.reduce((s, n) => s + cross(n), 0) + Math.max(0, row.length - 1) * COL_GAP)
  const maxCross = Math.max(0, ...layerCross)

  const pos = new Map<string, { x: number; y: number }>()
  let alongPos = down ? origin.y : origin.x
  layers.forEach((row, l) => {
    const rowAlong = Math.max(0, ...row.map(along)) // tallest/widest box drives the layer's band
    let crossPos = (down ? origin.x : origin.y) + (maxCross - layerCross[l]) / 2
    for (const n of row) {
      pos.set(n.id, down ? { x: crossPos, y: alongPos } : { x: alongPos, y: crossPos })
      crossPos += cross(n) + COL_GAP
    }
    alongPos += rowAlong + ROW_GAP
  })

  const ops: CanvasOp[] = []
  for (const n of spec.nodes) {
    const s = size.get(n.id)!
    const p = pos.get(n.id)!
    ops.push({
      op: 'create_geo',
      shape: n.kind ? KIND_TO_GEO[n.kind] : 'rectangle',
      x: Math.round(p.x),
      y: Math.round(p.y),
      w: s.w,
      h: s.h,
      text: n.label,
      ref: n.id,
    })
  }
  for (const e of edges) {
    ops.push({ op: 'connect_shapes', from: e.from, to: e.to, ...(e.label ? { text: e.label } : {}) })
  }
  return ops
}
