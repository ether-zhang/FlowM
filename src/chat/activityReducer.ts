import type { AgentActivityEvent, AgentToolStatus } from '../agentControl'

export interface DisplayToolActivity {
  id: string
  name: string
  toolKind?: 'command'
  status: AgentToolStatus
  detail?: string
  output?: string
}

export interface DisplayWarningActivity {
  id: string
  text: string
  detail?: string
}

export type DisplayActivityEntry =
  | { kind: 'thinking'; id: string; sourceId?: string }
  | { kind: 'commentary'; id: string; sourceId?: string }
  | { kind: 'tool'; id: string }
  | { kind: 'warning'; id: string }

export interface DisplayActivity {
  status: 'working' | 'completed' | 'failed'
  label?: string
  thinking: Record<string, string>
  commentary: Record<string, string>
  tools: DisplayToolActivity[]
  warnings: DisplayWarningActivity[]
  /** First-seen order of streamed content. Optional for sessions persisted before timelines. */
  timeline?: DisplayActivityEntry[]
}

export function createDisplayActivity(): DisplayActivity {
  return {
    status: 'working',
    thinking: {},
    commentary: {},
    tools: [],
    warnings: [],
    timeline: [],
  }
}

export function reduceActivity(state: DisplayActivity, event: AgentActivityEvent): DisplayActivity {
  if (event.type === 'status') {
    const terminalToolStatus = event.status === 'completed'
      ? 'completed'
      : event.status === 'failed'
        ? 'failed'
        : null
    return {
      ...state,
      status: event.status,
      ...(event.label ? { label: event.label } : {}),
      ...(terminalToolStatus
        ? {
            tools: state.tools.map((tool) => tool.status === 'running'
              ? { ...tool, status: terminalToolStatus }
              : tool),
          }
        : {}),
    }
  }
  if (event.type === 'thinking_delta') {
    return appendTextDelta(state, 'thinking', event.id, event.delta)
  }
  if (event.type === 'commentary_delta') {
    return appendTextDelta(state, 'commentary', event.id, event.delta)
  }
  if (event.type === 'tool') {
    const index = state.tools.findIndex((tool) => tool.id === event.id)
    const toolEvent: DisplayToolActivity = {
      id: event.id,
      name: event.name,
      ...(event.toolKind ? { toolKind: event.toolKind } : {}),
      status: event.status,
      ...(event.detail ? { detail: event.detail } : {}),
      ...(event.output ? { output: event.output } : {}),
    }
    const next = index < 0
      ? [...state.tools, toolEvent]
      : state.tools.map((tool, i) => i === index ? { ...tool, ...toolEvent } : tool)
    return {
      ...state,
      tools: next,
      timeline: appendTimeline(state, { kind: 'tool', id: event.id }),
    }
  }
  if (event.type === 'tool_status') {
    return {
      ...state,
      tools: state.tools.map((tool) => tool.id === event.id
        ? {
            ...tool,
            status: event.status,
            ...(event.output ? { output: event.output } : {}),
          }
        : tool),
    }
  }
  const warningEvent: DisplayWarningActivity = {
    id: event.id,
    text: event.text,
    ...(event.detail ? { detail: event.detail } : {}),
  }
  const index = state.warnings.findIndex((warning) => warning.id === event.id)
  if (index < 0) return {
    ...state,
    warnings: [...state.warnings, warningEvent],
    timeline: appendTimeline(state, { kind: 'warning', id: event.id }),
  }
  return {
    ...state,
    warnings: state.warnings.map((warning, i) => i === index
      ? {
          ...warning,
          text: event.text || warning.text,
          detail: [warning.detail, event.detail].filter(Boolean).join('\n'),
        }
      : warning),
  }
}

function appendTextDelta(
  state: DisplayActivity,
  kind: 'thinking' | 'commentary',
  sourceId: string,
  delta: string,
): DisplayActivity {
  const timeline = state.timeline ?? []
  const last = timeline.at(-1)
  const continuesLast = last?.kind === kind && (last.sourceId ?? last.id) === sourceId
  const id = continuesLast ? last.id : nextTextSegmentId(state[kind], sourceId)
  const entry: DisplayActivityEntry = id === sourceId
    ? { kind, id }
    : { kind, id, sourceId }
  return {
    ...state,
    [kind]: { ...state[kind], [id]: (state[kind][id] ?? '') + delta },
    timeline: continuesLast ? timeline : [...timeline, entry],
  }
}

function nextTextSegmentId(segments: Record<string, string>, sourceId: string): string {
  if (!(sourceId in segments)) return sourceId
  let index = 2
  while (`${sourceId}:${index}` in segments) index += 1
  return `${sourceId}:${index}`
}

function appendTimeline(state: DisplayActivity, entry: DisplayActivityEntry): DisplayActivityEntry[] {
  const timeline = state.timeline ?? []
  return timeline.some((item) => item.kind === entry.kind && item.id === entry.id)
    ? timeline
    : [...timeline, entry]
}
