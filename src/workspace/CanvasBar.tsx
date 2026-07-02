import type { CanvasMeta } from './types'

/**
 * Canvas controls that float at the top-right of the canvas (below Excalidraw's own Library button):
 * 新建画布 + a switcher. Canvases are decoupled from sessions — 新画布 makes a drawing surface only,
 * never a conversation. Shown only when a project is open (there's an active canvas to manage).
 */
export function CanvasBar({
  canvases,
  activeCanvasId,
  onNew,
  onSelect,
}: {
  canvases: CanvasMeta[]
  activeCanvasId: string | null
  onNew: () => void
  onSelect: (id: string) => void
}) {
  return (
    <div className="canvas-bar">
      <button className="canvas-new" onClick={onNew} title="新建画布（不新建对话）">
        + 画布
      </button>
      {canvases.length > 1 && (
        <select
          className="canvas-select"
          value={activeCanvasId ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          title="切换画布"
        >
          {canvases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
