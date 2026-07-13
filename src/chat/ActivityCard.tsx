import type { DisplayActivity, DisplayToolActivity } from './activityReducer'
import { activityRows, commandLabel } from './activityRows'
import { formatUiText, localizeSystemNote, type UiText } from '../app/uiText'

interface ActivityCardProps {
  activity: DisplayActivity
  text: UiText
}

const statusClass = (status: DisplayToolActivity['status']) => `activity-status activity-status-${status}`

export function ActivityCard({ activity, text }: ActivityCardProps) {
  const rows = activityRows(activity)
  const title = activity.label || (
    activity.status === 'working'
      ? text.chat.activityWorking
      : activity.status === 'failed'
        ? text.chat.activityFailed
        : text.chat.activityComplete
  )

  return (
    <details className={`msg msg-activity activity-${activity.status}`} open={activity.status === 'working'}>
      <summary>
        <span className="activity-state" aria-hidden="true" />
        <span className="activity-title">{title}</span>
        {activity.tools.length > 0 && (
          <span className="activity-count">
            {activity.tools.length} {activity.tools.length === 1 ? text.chat.activityTool : text.chat.activityTools}
          </span>
        )}
      </summary>
      <div className="activity-body">
        {rows.map((row) => {
          if (row.kind === 'commentary') {
            return <div key={`commentary-${row.id}`} className="activity-commentary">{row.text}</div>
          }
          if (row.kind === 'thinking') {
            return (
              <details key={`thinking-${row.id}`} className="activity-section activity-thinking">
                <summary>{text.chat.activityThinking}</summary>
                <div>{row.text}</div>
              </details>
            )
          }
          if (row.kind === 'tools') {
            const status = combinedStatus(row.tools)
            const label = formatUiText(
              row.tools.length === 1 ? text.chat.activityRanAction : text.chat.activityRanActions,
              { count: row.tools.length },
            )
            return (
              <details key={row.id} className="activity-tool-group">
                <summary>
                  <span className={statusClass(status)} aria-hidden="true" />
                  <span>{label}</span>
                </summary>
                <div className="activity-tool-list">
                  {row.tools.map((tool) => tool.toolKind === 'command'
                    ? <CommandRow key={tool.id} tool={tool} />
                    : <ToolRow key={tool.id} tool={tool} text={text} />)}
                </div>
              </details>
            )
          }
          if (row.kind === 'tool') return <ToolRow key={row.tool.id} tool={row.tool} text={text} />
          return (
            <details key={`warning-${row.warning.id}`} className="activity-section activity-warnings">
              <summary>{text.chat.activityDiagnostics}</summary>
              <div>
                <strong>{row.warning.text}</strong>
                {row.warning.detail && <pre>{row.warning.detail}</pre>}
              </div>
            </details>
          )
        })}
      </div>
    </details>
  )
}

function CommandRow({ tool }: { tool: DisplayToolActivity }) {
  const label = commandLabel(tool.detail)
  const detail = tool.detail && tool.detail !== label ? tool.detail : undefined
  const content = [detail, tool.output].filter(Boolean).join('\n\n')
  const summary = (
    <>
      <span className={statusClass(tool.status)} aria-hidden="true" />
      <code title={tool.detail}>{label}</code>
    </>
  )
  return content ? (
    <details className="activity-command">
      <summary>{summary}</summary>
      <pre>{content}</pre>
    </details>
  ) : (
    <div className="activity-command activity-command-plain">{summary}</div>
  )
}

function ToolRow({ tool, text }: { tool: DisplayToolActivity; text: UiText }) {
  const content = [tool.detail && localizeSystemNote(text, tool.detail), tool.output].filter(Boolean).join('\n\n')
  return content ? (
    <details className="activity-tool">
      <summary>
        <span className={statusClass(tool.status)} aria-hidden="true" />
        <span>{tool.name}</span>
      </summary>
      <pre>{content}</pre>
    </details>
  ) : (
    <div className="activity-tool activity-tool-plain">
      <span className={statusClass(tool.status)} aria-hidden="true" />
      <span>{tool.name}</span>
    </div>
  )
}

function combinedStatus(tools: DisplayToolActivity[]): DisplayToolActivity['status'] {
  if (tools.some((tool) => tool.status === 'running')) return 'running'
  if (tools.some((tool) => tool.status === 'failed')) return 'failed'
  if (tools.some((tool) => tool.status === 'declined')) return 'declined'
  return 'completed'
}
