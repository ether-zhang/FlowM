import { useState } from 'react'
import type { ConversationKind, ConversationMeta } from './types'

/**
 * The project + conversation switcher, shown as a collapsible strip at the top of the chat pane
 * (对话栏顶部折叠区). Presentational only — it calls back to the workspace hook; it owns no runtime.
 */
export function ConversationList({
  projectName,
  conversations,
  activeConvId,
  onOpenFolder,
  onNew,
  onSelect,
}: {
  projectName: string | null
  conversations: ConversationMeta[]
  activeConvId: string | null
  onOpenFolder: () => void
  onNew: (kind: ConversationKind) => void
  onSelect: (id: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="conv-list">
      <div className="conv-head">
        <button className="conv-collapse" onClick={() => setCollapsed((c) => !c)} title={collapsed ? '展开' : '折叠'}>
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="conv-project" title={projectName ?? ''}>
          {projectName ?? '未打开工程'}
        </span>
        <button className="conv-open" onClick={onOpenFolder} title="打开工程文件夹">
          打开工程
        </button>
      </div>
      {!collapsed && projectName && (
        <>
          <div className="conv-actions">
            <button onClick={() => onNew('canvas')} title="新建画布对话">+ 画布</button>
            <button onClick={() => onNew('text')} title="新建文本对话">+ 对话</button>
          </div>
          <div className="conv-rows">
            {conversations.map((c) => (
              <div
                key={c.id}
                className={`conv-row${c.id === activeConvId ? ' active' : ''}`}
                onClick={() => onSelect(c.id)}
                title={c.name}
              >
                <span className="conv-kind">{c.kind === 'canvas' ? '▦' : '💬'}</span>
                <span className="conv-name">{c.name}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
