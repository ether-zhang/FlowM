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
  let w = clamp(cols * 9 + 28, 110, 260)
  let h = clamp(lines.length * 22 + 30, 56, 200)
  if (node.kind === 'decision') {
    w = Math.max(w * 1.25, 130) // diamonds waste corners — give them girth
    h = Math.max(h * 1.3, 80)
  }
  return { w: Math.round(w), h: Math.round(h) }
}

/**
 * Layer (depth) per node = longest path from a root, by relaxation over edges. Roots are
 * nodes with no incoming edge; if a graph is all cycles (no root), the first node seeds
 * layer 0. Iteration is capped at node count so back-edges in a cycle can't loop forever.
 */
function assignLayers(ids: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const layer = new Map<string, number>(ids.map((id) => [id, 0]))
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false
    for (const e of edges) {
      const next = (layer.get(e.from) ?? 0) + 1
      if (next > (layer.get(e.to) ?? 0)) {
        layer.set(e.to, next)
        changed = true
      }
    }
    if (!changed) break
  }
  return layer
}

export function layoutDiagram(spec: DiagramSpec, origin: { x: number; y: number }): CanvasOp[] {
  const ids = new Set(spec.nodes.map((n) => n.id))
  // Edges are only layout/draw input when both ends are real nodes; drop dangling ones.
  const edges = spec.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  const down = (spec.dir ?? 'down') === 'down'

  const layer = assignLayers([...ids], edges)
  const size = new Map(spec.nodes.map((n) => [n.id, nodeSize(n)] as const))

  // Group nodes by layer, preserving spec order within a layer.
  const layers: DiagramNode[][] = []
  for (const n of spec.nodes) {
    const l = layer.get(n.id) ?? 0
    ;(layers[l] ??= []).push(n)
  }

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
