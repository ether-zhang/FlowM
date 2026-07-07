import { useEffect, useState } from 'react'
import { listDir, type FsEntry } from './store'
import type { UiText } from '../app/uiText'

/**
 * The right-hand file panel: a lazy tree over the project's code folder. Self-contained — it only
 * reads the `list_dir` backend command via the store, and holds nothing of the conversation/engine
 * state, so it composes into the shell without coupling. Each folder fetches its children on
 * expand (no deep recursion up front).
 */
export function FilePanel({
  folder,
  onOpenFile,
  onOpenFolder,
  onHide,
  text,
}: {
  folder: string
  /** Click a file → open it (the shell shows a floating editor). */
  onOpenFile?: (path: string) => void
  /** Pick the project's code folder (opens/creates the ~/.flowm project). */
  onOpenFolder?: () => void
  /** Collapse the panel (the shell shows a slim re-open rail). */
  onHide?: () => void
  text: UiText
}) {
  return (
    <div className="file-pane">
      <div className="file-toolbar">
        {onOpenFolder && (
          <button className="file-open" onClick={onOpenFolder} title={text.file.openProjectHint}>
            {text.file.openProject}
          </button>
        )}
        <span className="file-spacer" />
        {onHide && (
          <button className="file-hide" onClick={onHide} title={text.app.hidePanel}>
            «
          </button>
        )}
      </div>
      <div className="file-head" title={folder}>
        <span className="file-head-name">{folder.trim() ? baseName(folder) : text.file.noProject}</span>
      </div>
      {folder.trim() ? (
        <div className="file-tree">
          <DirChildren path={folder} depth={0} onOpenFile={onOpenFile} text={text} />
        </div>
      ) : (
        <div className="file-empty">{text.file.openProjectPrompt}</div>
      )}
    </div>
  )
}

/** The children of one directory, fetched lazily; re-fetched if `path` changes. */
function DirChildren({ path, depth, onOpenFile, text }: { path: string; depth: number; onOpenFile?: (path: string) => void; text: UiText }) {
  const [entries, setEntries] = useState<FsEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setEntries(null)
    setError(null)
    listDir(path)
      .then((e) => alive && setEntries(e))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [path])

  if (error) return <div className="file-note" style={indent(depth)}>{error}</div>
  if (!entries) return <div className="file-note" style={indent(depth)}>…</div>
  if (entries.length === 0) return <div className="file-note" style={indent(depth)}>({text.common.empty})</div>
  return (
    <>
      {entries.map((e) => (
        <Node key={e.path} entry={e} depth={depth} onOpenFile={onOpenFile} text={text} />
      ))}
    </>
  )
}

function Node({ entry, depth, onOpenFile, text }: { entry: FsEntry; depth: number; onOpenFile?: (path: string) => void; text: UiText }) {
  const [open, setOpen] = useState(false)
  if (!entry.isDir) {
    return (
      <div className="file-row" style={indent(depth)} title={entry.path} onClick={() => onOpenFile?.(entry.path)}>
        <span className="file-caret" />
        <span className="file-name">{entry.name}</span>
      </div>
    )
  }
  return (
    <>
      <div className="file-row is-dir" style={indent(depth)} onClick={() => setOpen((o) => !o)} title={entry.path}>
        <span className="file-caret">{open ? '▾' : '▸'}</span>
        <span className="file-name">{entry.name}</span>
      </div>
      {open && <DirChildren path={entry.path} depth={depth + 1} onOpenFile={onOpenFile} text={text} />}
    </>
  )
}

const indent = (depth: number) => ({ paddingLeft: 8 + depth * 14 })

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}
