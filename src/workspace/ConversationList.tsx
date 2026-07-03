import { useState } from 'react'
import type { SessionMeta } from './types'

/**
 * The session (chat-thread) switcher — a collapsible strip at the top of the chat pane. Sessions are
 * decoupled from canvases (新画布 lives on the canvas; 打开工程 lives on the file panel), so this list
 * is only about conversations. Presentational — it calls back to the workspace hook.
 */
export function ConversationList({
  projectName,
  sessions,
  activeSessionId,
  onNew,
  onSelect,
  onRename,
  onDelete,
}: {
  projectName: string | null
  sessions: SessionMeta[]
  activeSessionId: string | null
  onNew: () => void
  onSelect: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string, name: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="conv-list">
      <div className="conv-head">
        <button className="conv-collapse" onClick={() => setCollapsed((c) => !c)} title={collapsed ? '展开' : '折叠'}>
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="conv-project" title={projectName ?? ''}>
          {projectName ? `${projectName} · 对话` : '未打开工程（右侧文件栏「打开工程」）'}
        </span>
        {projectName && (
          <button className="conv-open" onClick={onNew} title="新建对话">
            + 对话
          </button>
        )}
      </div>
      {!collapsed && projectName && (
        <div className="conv-rows">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`conv-row${s.id === activeSessionId ? ' active' : ''}`}
              onClick={() => onSelect(s.id)}
              title={s.name}
            >
              <span className="conv-kind">💬</span>
              <span className="conv-name">{s.name}</span>
              <button
                className="row-btn"
                title="重命名"
                onClick={(e) => {
                  e.stopPropagation()
                  onRename(s.id, s.name)
                }}
              >
                ✎
              </button>
              <button
                className="row-btn"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(s.id, s.name)
                }}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
