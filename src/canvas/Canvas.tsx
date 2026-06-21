import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

/**
 * The center canvas. Excalidraw (MIT) ships the tools the MVP needs — Select,
 * Draw (画笔), Rectangle/Ellipse/Diamond (方块), Text (文字) and Arrow — plus
 * pan/zoom. We surface the live imperative API via onReady so the app can build
 * a CanvasPort over it.
 */
export function Canvas({ onReady }: { onReady: (api: ExcalidrawImperativeAPI) => void }) {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Excalidraw excalidrawAPI={onReady} />
    </div>
  )
}
