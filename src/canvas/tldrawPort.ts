import {
  type Editor,
  type TLShape,
  type TLShapeId,
  type TLGeoShape,
  createShapeId,
  toRichText,
  renderPlaintextFromRichText,
} from 'tldraw'
import type { CanvasPort, CanvasShape, CanvasOp, OpResult } from '../protocol'

/** Map a tldraw shape to the protocol's CanvasShape.type. */
function shapeType(shape: TLShape): CanvasShape['type'] {
  if (shape.type === 'geo') {
    const geo = (shape as TLGeoShape).props.geo
    if (geo === 'rectangle' || geo === 'ellipse' || geo === 'diamond' || geo === 'triangle') return geo
    return 'other'
  }
  if (shape.type === 'text') return 'text'
  if (shape.type === 'arrow') return 'arrow'
  if (shape.type === 'draw') return 'draw'
  return 'other'
}

function readText(editor: Editor, shape: TLShape): string | undefined {
  const rich = (shape.props as { richText?: unknown }).richText
  if (!rich) return undefined
  const text = renderPlaintextFromRichText(editor, rich as never).trim()
  return text || undefined
}

/**
 * For an arrow, read which shapes its start/end terminals are bound to. The
 * connection lives in tldraw bindings (not the arrow's props), so this is the
 * only source of truth — same place createBindings wrote it.
 *
 * TODO: unbound (free-floating) arrows have no binding, so from/to stay
 * undefined and the model only sees their coordinates. If hand-drawn arrows that
 * visually point between shapes need to be understood, infer endpoints from
 * terminal geometry (nearest shape under each tip) as a fallback.
 */
function arrowEnds(editor: Editor, shape: TLShape): { from?: string; to?: string } {
  if (shape.type !== 'arrow') return {}
  const ends: { from?: string; to?: string } = {}
  for (const b of editor.getBindingsFromShape(shape.id, 'arrow')) {
    const terminal = (b.props as { terminal?: 'start' | 'end' }).terminal
    if (terminal === 'start') ends.from = b.toId
    else if (terminal === 'end') ends.to = b.toId
  }
  return ends
}

/** Bind one terminal of an arrow to a target shape's center. */
function bindArrow(editor: Editor, arrowId: TLShapeId, targetId: TLShapeId, terminal: 'start' | 'end') {
  editor.createBindings([
    {
      fromId: arrowId,
      toId: targetId,
      type: 'arrow',
      props: {
        terminal,
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
      },
    },
  ])
}

/**
 * Bind the protocol's CanvasPort to a live tldraw Editor. This is the only place
 * that knows about tldraw types — the protocol and LLM layers stay agnostic.
 */
export function createTldrawPort(editor: Editor): CanvasPort {
  return {
    snapshot(scope) {
      const shapes =
        scope === 'selection' && editor.getSelectedShapeIds().length > 0
          ? editor.getSelectedShapes()
          : editor.getCurrentPageShapes()
      return shapes.map((shape): CanvasShape => {
        const bounds = editor.getShapePageBounds(shape)
        return {
          id: shape.id,
          type: shapeType(shape),
          x: bounds?.x ?? shape.x,
          y: bounds?.y ?? shape.y,
          w: bounds?.w,
          h: bounds?.h,
          text: readText(editor, shape),
          ...arrowEnds(editor, shape),
        }
      })
    },

    apply(ops: CanvasOp[]): OpResult[] {
      const refs = new Map<string, TLShapeId>()
      const resolve = (key: string): TLShapeId | undefined =>
        refs.get(key) ?? (key.startsWith('shape:') ? (key as TLShapeId) : undefined)

      const results: OpResult[] = []
      editor.run(() => {
        for (const op of ops) {
          try {
            results.push(applyOne(editor, op, refs, resolve))
          } catch (e) {
            results.push({ op: op.op, ok: false, error: (e as Error).message })
          }
        }
      })
      return results
    },
  }
}

function applyOne(
  editor: Editor,
  op: CanvasOp,
  refs: Map<string, TLShapeId>,
  resolve: (key: string) => TLShapeId | undefined,
): OpResult {
  switch (op.op) {
    case 'create_geo': {
      const id = createShapeId()
      editor.createShape({
        id,
        type: 'geo',
        x: op.x,
        y: op.y,
        props: { geo: op.shape, w: op.w, h: op.h, richText: toRichText(op.text ?? '') },
      })
      if (op.ref) refs.set(op.ref, id)
      return { op: op.op, ok: true, id, ref: op.ref }
    }
    case 'create_text': {
      const id = createShapeId()
      editor.createShape({ id, type: 'text', x: op.x, y: op.y, props: { richText: toRichText(op.text) } })
      if (op.ref) refs.set(op.ref, id)
      return { op: op.op, ok: true, id, ref: op.ref }
    }
    case 'move_shape': {
      const shape = editor.getShape(op.id as TLShapeId)
      if (!shape) return { op: op.op, ok: false, error: `no shape ${op.id}` }
      editor.updateShape({ id: shape.id, type: shape.type, x: op.x, y: op.y } as TLShape)
      return { op: op.op, ok: true, id: shape.id }
    }
    case 'update_text': {
      const shape = editor.getShape(op.id as TLShapeId)
      if (!shape) return { op: op.op, ok: false, error: `no shape ${op.id}` }
      editor.updateShape({
        id: shape.id,
        type: shape.type,
        props: { richText: toRichText(op.text) },
      } as TLShape)
      return { op: op.op, ok: true, id: shape.id }
    }
    case 'delete_shape': {
      const id = op.id as TLShapeId
      if (!editor.getShape(id)) return { op: op.op, ok: false, error: `no shape ${op.id}` }
      editor.deleteShape(id)
      return { op: op.op, ok: true, id }
    }
    case 'connect_shapes': {
      const from = resolve(op.from)
      const to = resolve(op.to)
      if (!from || !to) return { op: op.op, ok: false, error: `unresolved ${op.from} or ${op.to}` }
      const arrowId = createShapeId()
      editor.createShape({ id: arrowId, type: 'arrow', props: { richText: toRichText(op.text ?? '') } })
      bindArrow(editor, arrowId, from, 'start')
      bindArrow(editor, arrowId, to, 'end')
      return { op: op.op, ok: true, id: arrowId }
    }
  }
}
