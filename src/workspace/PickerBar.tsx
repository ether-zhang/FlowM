import { useEffect, useRef, useState } from 'react'
import type { UiText } from '../app/uiText'

/**
 * A compact Claude-Code-style picker used for BOTH sessions and canvases (画布 ⊥ session, same UX):
 * a rounded bar showing the current item's name, a history button that drops down the full list
 * (searchable, each row with rename/delete), and a new button. Double-clicking a name — in the bar
 * or a row — renames it inline (commit on Enter/blur, cancel on Escape). Presentational: it calls
 * back to the workspace hook; delete still routes through the caller's confirm dialog.
 */
interface PickerItem {
  id: string
  name: string
}

const ClockIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.8V8l2.2 1.6" />
  </svg>
)
const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
)

export function PickerBar({
  items,
  activeId,
  placeholder,
  newTitle,
  onSelect,
  onNew,
  onRename,
  onDelete,
  text,
}: {
  items: PickerItem[]
  activeId: string | null
  /** Shown in the bar when there's no active item (e.g. no project open). */
  placeholder: string
  /** Tooltip for the + button. */
  newTitle: string
  onSelect: (id: string) => void
  onNew: () => void
  /** Inline rename commits directly (no modal). */
  onRename: (id: string, name: string) => void
  /** Delete routes through the caller's confirm dialog. */
  onDelete: (id: string, name: string) => void
  text: UiText
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const active = items.find((i) => i.id === activeId) ?? null
  const hasItems = items.length > 0

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const startEdit = (it: PickerItem) => {
    setDraft(it.name)
    setEditingId(it.id)
  }
  const commitEdit = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }
  const editorProps = {
    className: 'picker-edit',
    autoFocus: true,
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') commitEdit()
      else if (e.key === 'Escape') setEditingId(null)
    },
    onBlur: commitEdit,
  }

  const q = query.trim().toLowerCase()
  const filtered = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items

  return (
    <div className="picker" ref={rootRef}>
      <div className="picker-bar">
        {editingId && editingId === active?.id ? (
          <input {...editorProps} />
        ) : (
          <span className="picker-name" title={active ? text.picker.renameHint : ''} onDoubleClick={() => active && startEdit(active)}>
            {active ? active.name : placeholder}
          </span>
        )}
        <button className="picker-icon" title={text.picker.history} onClick={() => setOpen((o) => !o)} disabled={!hasItems}>
          <ClockIcon />
        </button>
        <button className="picker-icon" title={newTitle} onClick={onNew} disabled={!hasItems}>
          <PlusIcon />
        </button>
      </div>
      {open && (
        <div className="picker-menu">
          <input className="picker-search" placeholder={text.picker.search} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          <div className="picker-rows">
            {filtered.map((it) => (
              <div
                key={it.id}
                className={`picker-row${it.id === activeId ? ' active' : ''}`}
                onClick={() => {
                  onSelect(it.id)
                  setOpen(false)
                }}
              >
                {editingId === it.id ? (
                  <input {...editorProps} onClick={(e) => e.stopPropagation()} />
                ) : (
                  <span
                    className="picker-row-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      startEdit(it)
                    }}
                  >
                    {it.name}
                  </span>
                )}
                <button
                  className="picker-row-btn"
                  title={text.picker.rename}
                  onClick={(e) => {
                    e.stopPropagation()
                    startEdit(it)
                  }}
                >
                  ✎
                </button>
                <button
                  className="picker-row-btn"
                  title={text.picker.delete}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(it.id, it.name)
                  }}
                >
                  🗑
                </button>
              </div>
            ))}
            {filtered.length === 0 && <div className="picker-empty">{text.picker.noMatch}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
