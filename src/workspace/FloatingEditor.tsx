import { useCallback, useEffect, useState } from 'react'
import { readFile, writeFile } from './store'
import type { UiText } from '../app/uiText'

/**
 * A floating, draggable text editor for one project file. Opened by clicking a file in the panel;
 * loads via read_file, saves via write_file. Kept self-contained (only the store), so the shell
 * just renders <FloatingEditor path onClose /> when a file is open — no coupling to conversations.
 */
export function FloatingEditor({ path, onClose, text: uiText }: { path: string; onClose: () => void; text: UiText }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 120, y: 80 })

  useEffect(() => {
    let alive = true
    setText(null)
    setError(null)
    setDirty(false)
    readFile(path)
      .then((c) => alive && setText(c))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [path])

  // Drag the window by its title bar (pointer capture so a fast drag doesn't drop).
  const onDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('button')) return // let the close button click through
      const el = e.currentTarget
      const startX = e.clientX
      const startY = e.clientY
      const start = pos
      el.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent) => setPos({ x: start.x + (ev.clientX - startX), y: start.y + (ev.clientY - startY) })
      const up = () => {
        el.releasePointerCapture(e.pointerId)
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    },
    [pos],
  )

  const save = useCallback(async () => {
    if (text == null) return
    setSaving(true)
    try {
      await writeFile(path, text)
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [path, text])

  return (
    <div className="float-editor" style={{ left: pos.x, top: pos.y }}>
      <div className="float-editor-bar" onPointerDown={onDragStart}>
        <span className="float-editor-title" title={path}>{baseName(path)}{dirty ? ' •' : ''}</span>
        <span className="float-editor-spacer" />
        <button onClick={save} disabled={saving || !dirty || text == null}>{saving ? '…' : uiText.file.save}</button>
        <button onClick={onClose}>✕</button>
      </div>
      {error ? (
        <div className="float-editor-note">{error}</div>
      ) : text == null ? (
        <div className="float-editor-note">…</div>
      ) : (
        <textarea
          className="float-editor-body"
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            setDirty(true)
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault()
              save()
            }
          }}
        />
      )}
    </div>
  )
}

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}
