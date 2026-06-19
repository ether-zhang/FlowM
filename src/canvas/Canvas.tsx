import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'

/**
 * The center canvas. tldraw's default toolbar already provides the tools the MVP
 * needs — Select, Draw (画笔), the geo/Rectangle (方块) tool, and Text (文字) —
 * plus arrows and more. We surface the live Editor via onEditor so the app can
 * build a CanvasPort over it.
 */
export function Canvas({ onEditor }: { onEditor: (editor: Editor) => void }) {
  return (
    <Tldraw
      persistenceKey="flowm-canvas"
      onMount={(editor) => onEditor(editor)}
    />
  )
}
