import type {
  DisplayActivity,
  DisplayActivityEntry,
  DisplayToolActivity,
  DisplayWarningActivity,
} from './activityReducer'

export type DisplayActivityRow =
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'commentary'; id: string; text: string }
  | { kind: 'tool'; tool: DisplayToolActivity }
  | { kind: 'tools'; id: string; tools: DisplayToolActivity[] }
  | { kind: 'warning'; warning: DisplayWarningActivity }

export function activityRows(activity: DisplayActivity): DisplayActivityRow[] {
  const rows: DisplayActivityRow[] = []
  for (const entry of activity.timeline ?? legacyTimeline(activity)) {
    if (entry.kind === 'thinking' || entry.kind === 'commentary') {
      const text = activity[entry.kind][entry.id]?.trim()
      if (text) rows.push({ kind: entry.kind, id: entry.id, text })
      continue
    }
    if (entry.kind === 'warning') {
      const warning = activity.warnings.find((item) => item.id === entry.id)
      if (warning) rows.push({ kind: 'warning', warning })
      continue
    }
    const tool = activity.tools.find((item) => item.id === entry.id)
    if (!tool) continue
    const previous = rows.at(-1)
    if (previous?.kind === 'tools') previous.tools.push(tool)
    else rows.push({ kind: 'tools', id: `tools-${tool.id}`, tools: [tool] })
  }
  return rows.flatMap((row) => row.kind === 'tools' && row.tools.length === 1
    ? [{ kind: 'tool' as const, tool: row.tools[0] }]
    : [row])
}

export function commandLabel(command: string | undefined): string {
  if (!command) return 'Command'
  const normalized = command.replace(/\s+/g, ' ').trim()
  const wrapped = /(?:^|\s)-(?:Command|c)\s+(["'])([\s\S]*)\1$/i.exec(normalized)
  const readable = wrapped?.[2]?.trim() || normalized
  return readable.length > 120 ? `${readable.slice(0, 117)}...` : readable
}

function legacyTimeline(activity: DisplayActivity): DisplayActivityEntry[] {
  return [
    ...Object.keys(activity.commentary).map((id) => ({ kind: 'commentary' as const, id })),
    ...Object.keys(activity.thinking).map((id) => ({ kind: 'thinking' as const, id })),
    ...activity.tools.map((tool) => ({ kind: 'tool' as const, id: tool.id })),
    ...activity.warnings.map((warning) => ({ kind: 'warning' as const, id: warning.id })),
  ]
}
