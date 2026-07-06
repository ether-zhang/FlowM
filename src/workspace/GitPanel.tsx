import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { gitDiff, gitGraph, gitStatus, type GitCommit, type GitFile, type GitStatus } from './git'

interface TreeNode {
  name: string
  path: string
  children: TreeNode[]
  file?: GitFile
}

export function GitPanel({ folder, onHide }: { folder: string; onHide?: () => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [graph, setGraph] = useState<GitCommit[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [loading, setLoading] = useState(false)
  const [graphLoading, setGraphLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshId, setRefreshId] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [graphOpen, setGraphOpen] = useState(true)
  const [diffOpen, setDiffOpen] = useState(true)

  useEffect(() => {
    if (!folder.trim()) {
      setStatus(null)
      setGraph([])
      setSelected(null)
      setError(null)
      return
    }
    let alive = true
    setLoading(true)
    setGraphLoading(true)
    setError(null)
    Promise.all([gitStatus(folder), gitGraph(folder).catch(() => [] as GitCommit[])])
      .then(([next, commits]) => {
        if (!alive) return
        setStatus(next)
        setGraph(commits)
        setCollapsed(new Set())
        setSelected((prev) => {
          if (prev && next.files.some((file) => file.path === prev)) return prev
          return next.files[0]?.path ?? null
        })
      })
      .catch((err) => {
        if (!alive) return
        setStatus(null)
        setGraph([])
        setSelected(null)
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (alive) {
          setLoading(false)
          setGraphLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [folder, refreshId])

  useEffect(() => {
    if (!folder.trim() || !selected) {
      setDiff('')
      return
    }
    let alive = true
    setDiffLoading(true)
    gitDiff(folder, selected)
      .then((text) => {
        if (alive) setDiff(text)
      })
      .catch((err) => {
        if (alive) setDiff(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (alive) setDiffLoading(false)
      })
    return () => {
      alive = false
    }
  }, [folder, selected])

  const tree = useMemo(() => buildTree(status?.files ?? []), [status])
  const selectedFile = status?.files.find((file) => file.path === selected) ?? null

  const toggleFolder = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="git-panel">
      <div className="activity-panel-head">
        <span className="activity-panel-title">源代码管理</span>
        <button className="git-icon-btn" onClick={() => setRefreshId((n) => n + 1)} title="刷新">
          ↻
        </button>
        {onHide && (
          <button className="file-hide" onClick={onHide} title="隐藏侧栏">
            «
          </button>
        )}
      </div>

      {!folder.trim() ? (
        <div className="activity-empty">先打开工程后查看 Git 状态。</div>
      ) : error ? (
        <div className="activity-empty">{error}</div>
      ) : (
        <>
          <div className="git-meta">
            <span className="git-branch">{status?.branch ?? '...'}</span>
            <span className="git-head">{status?.head ?? ''}</span>
          </div>
          <div className="git-section-title">更改 {status ? status.files.length : loading ? '' : 0}</div>
          <div className="git-tree">
            {loading ? (
              <div className="git-note">读取中...</div>
            ) : tree.length ? (
              <GitTreeRows
                nodes={tree}
                depth={0}
                selected={selected}
                collapsed={collapsed}
                onSelect={setSelected}
                onToggleFolder={toggleFolder}
              />
            ) : (
              <div className="git-note">没有更改</div>
            )}
          </div>
          <GitCollapse
            title="图表"
            meta={graph.length ? String(graph.length) : undefined}
            open={graphOpen}
            onToggle={() => setGraphOpen((open) => !open)}
            className="git-graph-section"
          >
            <div className="git-graph">
              {graphLoading ? (
                <div className="git-note">加载图表...</div>
              ) : graph.length ? (
                <GitGraphRows commits={graph} currentBranch={status?.branch ?? ''} />
              ) : (
                <div className="git-note">没有提交记录</div>
              )}
            </div>
          </GitCollapse>
          <GitCollapse
            title={selectedFile?.path ?? 'Diff'}
            meta={selectedFile ? statusLabel(selectedFile) : undefined}
            metaClass={selectedFile ? statusKind(selectedFile) : undefined}
            open={diffOpen}
            onToggle={() => setDiffOpen((open) => !open)}
            className="git-diff-section"
          >
            <div className="git-diff">
              {diffLoading ? (
                <div className="git-note">加载 diff...</div>
              ) : selected ? (
                <DiffText text={diff || '没有 diff'} />
              ) : (
                <div className="git-note">选择一个文件查看 diff</div>
              )}
            </div>
          </GitCollapse>
        </>
      )}
    </div>
  )
}

function GitCollapse({
  title,
  meta,
  metaClass,
  open,
  onToggle,
  className,
  children,
}: {
  title: string
  meta?: string
  metaClass?: string
  open: boolean
  onToggle: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`git-collapsible${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button className="git-collapse-head" onClick={onToggle} title={open ? '折叠' : '展开'}>
        <span className="git-collapse-caret">{open ? '▾' : '▸'}</span>
        <span className="git-collapse-title">{title}</span>
        {meta && <span className={`git-collapse-meta ${metaClass ?? ''}`}>{meta}</span>}
      </button>
      {open && children}
    </section>
  )
}

function GitGraphRows({ commits, currentBranch }: { commits: GitCommit[]; currentBranch: string }) {
  return (
    <>
      {commits.map((commit, index) => (
        <div key={commit.hash} className="git-graph-row">
          <div className="git-graph-rail">
            <span className={`git-graph-line${index === commits.length - 1 ? ' last' : ''}`} />
            <span className={`git-graph-dot${index === 0 ? ' head' : ''}`} />
          </div>
          <div className="git-graph-main">
            <div className="git-graph-message">
              <span className="git-graph-subject">{commit.subject}</span>
              <span className="git-graph-author">{commit.author}</span>
            </div>
            {commit.refs.length > 0 && (
              <div className="git-refs">
                {commit.refs.map((ref) => (
                  <span key={ref} className={`git-ref${isCurrentRef(ref, currentBranch) ? ' current' : ''}`}>
                    {cleanRef(ref)}
                  </span>
                ))}
              </div>
            )}
          </div>
          <span className="git-graph-hash">{commit.shortHash}</span>
        </div>
      ))}
    </>
  )
}

function cleanRef(ref: string): string {
  return ref.replace(/^HEAD -> /, '')
}

function isCurrentRef(ref: string, currentBranch: string): boolean {
  return ref === `HEAD -> ${currentBranch}` || ref === currentBranch
}

function GitTreeRows({
  nodes,
  depth,
  selected,
  collapsed,
  onSelect,
  onToggleFolder,
}: {
  nodes: TreeNode[]
  depth: number
  selected: string | null
  collapsed: Set<string>
  onSelect: (path: string) => void
  onToggleFolder: (path: string) => void
}) {
  return (
    <>
      {nodes.map((node) => {
        if (!node.file) {
          const isCollapsed = collapsed.has(node.path)
          return (
            <div key={node.path}>
              <button className="git-row git-dir" style={indent(depth)} onClick={() => onToggleFolder(node.path)} title={node.path}>
                <span className="git-caret">{isCollapsed ? '▸' : '▾'}</span>
                <span className="git-name">{node.name}</span>
              </button>
              {!isCollapsed && (
                <GitTreeRows
                  nodes={node.children}
                  depth={depth + 1}
                  selected={selected}
                  collapsed={collapsed}
                  onSelect={onSelect}
                  onToggleFolder={onToggleFolder}
                />
              )}
            </div>
          )
        }
        const kind = statusKind(node.file)
        return (
          <button
            key={node.path}
            className={`git-row git-file${selected === node.path ? ' active' : ''}`}
            style={indent(depth)}
            onClick={() => onSelect(node.path)}
            title={node.path}
          >
            <span className={`git-status ${kind}`}>{statusLabel(node.file)}</span>
            <span className="git-name">{node.name}</span>
          </button>
        )
      })}
    </>
  )
}

function DiffText({ text }: { text: string }) {
  return (
    <pre>
      {text.split('\n').map((line, i) => (
        <span key={i} className={diffLineClass(line)}>
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}

function buildTree(files: GitFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] }
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let node = root
    let path = ''
    parts.forEach((part, index) => {
      path = path ? `${path}/${part}` : part
      let child = node.children.find((candidate) => candidate.name === part)
      if (!child) {
        child = { name: part, path, children: [] }
        node.children.push(child)
      }
      if (index === parts.length - 1) child.file = file
      node = child
    })
  }
  sortTree(root.children)
  return root.children
}

function sortTree(nodes: TreeNode[]) {
  nodes.sort((a, b) => {
    const aDir = !a.file
    const bDir = !b.file
    return Number(bDir) - Number(aDir) || a.name.localeCompare(b.name)
  })
  nodes.forEach((node) => sortTree(node.children))
}

function statusLabel(file: GitFile): string {
  if (file.isUntracked) return 'U'
  const code = `${file.indexStatus}${file.worktreeStatus}`
  if (code.includes('U')) return '!'
  if (code.includes('R')) return 'R'
  if (code.includes('A')) return 'A'
  if (code.includes('D')) return 'D'
  if (code.includes('M')) return 'M'
  return file.status.trim() || '?'
}

function statusKind(file: GitFile): string {
  const label = statusLabel(file)
  if (label === 'U' || label === 'A') return 'add'
  if (label === 'D') return 'delete'
  if (label === '!' || label === 'R') return 'warn'
  return 'mod'
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('diff --git')) return 'meta'
  return ''
}

const indent = (depth: number) => ({ paddingLeft: 8 + depth * 14 })
