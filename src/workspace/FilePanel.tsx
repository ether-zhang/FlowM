import { useEffect, useState } from 'react'
import { listDir, type FsEntry } from './store'

/**
 * The right-hand file panel: a lazy tree over the project's code folder. Self-contained — it only
 * reads the `list_dir` backend command via the store, and holds nothing of the conversation/engine
 * state, so it composes into the shell without coupling. Each folder fetches its children on
 * expand (no deep recursion up front).
 */
export function FilePanel({
  folder,
  onOpenFile,
  onHide,
}: {
  folder: string
  /** Click a file → open it (the shell shows a floating editor). */
  onOpenFile?: (path: string) => void
  /** Collapse the panel (the shell shows a slim re-open rail). */
  onHide?: () => void
}) {
  return (
    <div className="file-pane">
      <div className="file-head" title={folder}>
        <span className="file-head-name">{folder.trim() ? baseName(folder) : '未选择工程目录'}</span>
        {onHide && (
          <button className="file-hide" onClick={onHide} title="隐藏文件栏">
            «
          </button>
        )}
      </div>
      {folder.trim() ? (
        <div className="file-tree">
          <DirChildren path={folder} depth={0} onOpenFile={onOpenFile} />
        </div>
      ) : (
        <div className="file-empty">在下方对话栏填写 / 选择工程目录后显示文件</div>
      )}
    </div>
  )
}

/** The children of one directory, fetched lazily; re-fetched if `path` changes. */
function DirChildren({ path, depth, onOpenFile }: { path: string; depth: number; onOpenFile?: (path: string) => void }) {
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
  if (entries.length === 0) return <div className="file-note" style={indent(depth)}>（空）</div>
  return (
    <>
      {entries.map((e) => (
        <Node key={e.path} entry={e} depth={depth} onOpenFile={onOpenFile} />
      ))}
    </>
  )
}

function Node({ entry, depth, onOpenFile }: { entry: FsEntry; depth: number; onOpenFile?: (path: string) => void }) {
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
      {open && <DirChildren path={entry.path} depth={depth + 1} onOpenFile={onOpenFile} />}
    </>
  )
}

const indent = (depth: number) => ({ paddingLeft: 8 + depth * 14 })

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}
