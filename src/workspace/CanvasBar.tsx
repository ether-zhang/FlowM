import type { CanvasMeta } from './types'

/**
 * Canvas controls that float at the top-right of the canvas (below Excalidraw's own Library button):
 * 新建画布 + a switcher + rename/delete for the active canvas. Canvases are decoupled from sessions —
 * 新画布 makes a drawing surface only, never a conversation. Shown only when a project is open.
 */
export function CanvasBar({
  canvases,
  activeCanvasId,
  onNew,
  onSelect,
  onRename,
  onDelete,
}: {
  canvases: CanvasMeta[]
  activeCanvasId: string | null
  onNew: () => void
  onSelect: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string, name: string) => void
}) {
  const active = canvases.find((c) => c.id === activeCanvasId)
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
      {active && (
        <>
          <button className="canvas-icon" title={`重命名「${active.name}」`} onClick={() => onRename(active.id, active.name)}>
            ✎
          </button>
          <button className="canvas-icon" title={`删除「${active.name}」`} onClick={() => onDelete(active.id, active.name)}>
            🗑
          </button>
        </>
      )}
    </div>
  )
}
