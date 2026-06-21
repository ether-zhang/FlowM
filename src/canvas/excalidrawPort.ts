import {
  convertToExcalidrawElements,
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
import type { CanvasPort, CanvasShape, CanvasOp, OpResult } from '../protocol'

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
const center = (el: { x: number; y: number; width: number; height: number }) => ({
  x: el.x + el.width / 2,
  y: el.y + el.height / 2,
})
const newId = () => `flowm-${crypto.randomUUID()}`

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
  return {
    snapshot(scope) {
      const all = getNonDeletedElements(api.getSceneElements())
      const selected = api.getAppState().selectedElementIds
      const useSelection = scope === 'selection' && Object.keys(selected).length > 0

      // A labeled container stores its text as a separate child element
      // (containerId === container.id). Fold those into the container's `text`
      // and don't surface them as standalone shapes — mirrors the old behavior.
      const labelByContainer = new Map<string, string>()
      for (const el of all) {
        if (isText(el) && el.containerId) labelByContainer.set(el.containerId, el.text)
      }

      return all
        .filter((el) => !(isText(el) && el.containerId)) // drop bound labels
        .filter((el) => (useSelection ? selected[el.id] : true))
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

    apply(ops: CanvasOp[]): OpResult[] {
      const byId = new Map<string, ExcalidrawElement>()
      for (const el of getNonDeletedElements(api.getSceneElements())) byId.set(el.id, el)

      const refs = new Map<string, string>() // create-ref → assigned id
      const pending = new Map<string, { x: number; y: number; width: number; height: number }>()
      const skeleton: ExcalidrawElementSkeleton[] = []
      const results: OpResult[] = new Array(ops.length)

      // Resolve an op's id/ref to a real element id (existing scene shape or a
      // shape created earlier in this same batch).
      const resolve = (key: string): string | undefined =>
        refs.get(key) ?? (byId.has(key) || pending.has(key) ? key : undefined)
      const geomOf = (id: string) => pending.get(id) ?? byId.get(id)

      ops.forEach((op, i) => {
        switch (op.op) {
          case 'create_geo': {
            const id = newId()
            // Excalidraw has no triangle; approximate with a diamond for now.
            // TODO: render true triangles via a closed 3-point line polygon.
            const geo = op.shape === 'triangle' ? 'diamond' : op.shape
            skeleton.push({
              type: geo,
              id,
              x: op.x,
              y: op.y,
              width: op.w,
              height: op.h,
              ...(op.text ? { label: { text: op.text } } : {}),
            } as ExcalidrawElementSkeleton)
            if (op.ref) refs.set(op.ref, id)
            pending.set(id, { x: op.x, y: op.y, width: op.w, height: op.h })
            results[i] = { op: op.op, ok: true, id, ref: op.ref }
            break
          }
          case 'create_text': {
            const id = newId()
            skeleton.push({ type: 'text', id, x: op.x, y: op.y, text: op.text } as ExcalidrawElementSkeleton)
            if (op.ref) refs.set(op.ref, id)
            results[i] = { op: op.op, ok: true, id, ref: op.ref }
            break
          }
          case 'connect_shapes': {
            const from = resolve(op.from)
            const to = resolve(op.to)
            if (!from || !to) {
              results[i] = { op: op.op, ok: false, error: `unresolved ${op.from} or ${op.to}` }
              break
            }
            const id = newId()
            const a = geomOf(from)
            const b = geomOf(to)
            const start = a ? center(a) : { x: 0, y: 0 }
            // Excalidraw's skeleton converter only binds start/end to elements
            // present in THIS batch. When both endpoints are freshly created we
            // bind by id; otherwise fall back to a plain arrow between centers.
            // TODO: bind arrows to pre-existing scene shapes (needs focus/gap).
            const bothNew = pending.has(from) && pending.has(to)
            if (bothNew) {
              skeleton.push({
                type: 'arrow',
                id,
                x: start.x,
                y: start.y,
                start: { id: from },
                end: { id: to },
                ...(op.text ? { label: { text: op.text } } : {}),
              } as ExcalidrawElementSkeleton)
            } else {
              const end = b ? center(b) : start
              skeleton.push({
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
                ...(op.text ? { label: { text: op.text } } : {}),
              } as ExcalidrawElementSkeleton)
            }
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
            // Bound text labels carry their own coordinates — shift them too.
            for (const t of byId.values()) {
              if (isText(t) && t.containerId === el.id) {
                byId.set(t.id, newElementWith(t, { x: t.x + dx, y: t.y + dy }))
              }
            }
            results[i] = { op: op.op, ok: true, id: el.id }
            break
          }
          case 'update_text': {
            const el = byId.get(op.id)
            if (!el) {
              results[i] = { op: op.op, ok: false, error: `no shape ${op.id}` }
              break
            }
            if (isText(el)) {
              byId.set(el.id, newElementWith(el, { text: op.text, originalText: op.text }))
            } else {
              // Labeled container: update its bound text child if present.
              for (const t of byId.values()) {
                if (isText(t) && t.containerId === el.id) {
                  byId.set(t.id, newElementWith(t, { text: op.text, originalText: op.text }))
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

      // Convert all newly created shapes/arrows in one batch so in-batch arrow
      // bindings resolve, then write the whole scene back.
      const created = skeleton.length ? convertToExcalidrawElements(skeleton) : []
      api.updateScene({ elements: [...byId.values(), ...created] })
      return results
    },

    serialize() {
      // The element array round-trips losslessly; persistence treats it opaquely.
      return getNonDeletedElements(api.getSceneElements())
    },

    deserialize(data: unknown) {
      api.updateScene({ elements: (data as ExcalidrawElement[]) ?? [] })
    },
  }
}
