export type ActivityView = 'files' | 'search' | 'git'

export const activityViews: Array<{ id: ActivityView; label: string }> = [
  { id: 'files', label: '资源管理器' },
  { id: 'search', label: '搜索' },
  { id: 'git', label: '源代码管理' },
]

export const isActivityView = (v: string | null): v is ActivityView =>
  v === 'files' || v === 'search' || v === 'git'

function ActivityIcon({ view }: { view: ActivityView }) {
  if (view === 'search') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6" />
        <path d="m16 16 4 4" />
      </svg>
    )
  }
  if (view === 'git') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="M8 6h4a4 4 0 0 1 4 4v6" />
        <path d="M6 8v6a4 4 0 0 0 4 4" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 4h6l2 3h6v13H5z" />
      <path d="M5 9h14" />
    </svg>
  )
}

export function ActivityBar({
  active,
  panelOpen,
  onSelect,
}: {
  active: ActivityView
  panelOpen: boolean
  onSelect: (view: ActivityView) => void
}) {
  return (
    <nav className="activity-bar" aria-label="工作区视图">
      <div className="activity-group">
        {activityViews.map((view) => (
          <button
            key={view.id}
            className={`activity-btn${active === view.id && panelOpen ? ' active' : ''}`}
            title={view.label}
            aria-label={view.label}
            aria-pressed={active === view.id && panelOpen}
            onClick={() => onSelect(view.id)}
          >
            <ActivityIcon view={view.id} />
          </button>
        ))}
      </div>
    </nav>
  )
}
