export interface AgentQuestionOption {
  label: string
  description?: string
}

export interface AgentQuestionItem {
  /** Provider-independent key used to correlate this item with its answer. */
  id: string
  prompt: string
  header?: string
  options?: AgentQuestionOption[]
  multiSelect?: boolean
  allowOther?: boolean
  secret?: boolean
}

/**
 * A user-input request emitted by an agent. `requestId` is present only when the provider has
 * paused an in-flight turn and expects a protocol response. Without it, the answer starts the
 * next turn through the legacy structured-output fallback.
 */
export interface AgentQuestion {
  requestId?: string
  items: AgentQuestionItem[]
  autoResolutionMs?: number
}

export interface AgentQuestionAnswer {
  requestId: string
  answers: Record<string, string[]>
}

export type AgentToolStatus = 'running' | 'completed' | 'failed' | 'declined'

/** Provider-neutral events emitted while an agent turn is in flight. */
export type AgentActivityEvent =
  | { type: 'status'; status: 'working' | 'completed' | 'failed'; label?: string }
  | { type: 'thinking_delta'; id: string; delta: string }
  | { type: 'commentary_delta'; id: string; delta: string }
  | {
      type: 'tool'
      id: string
      name: string
      toolKind?: 'command'
      status: AgentToolStatus
      detail?: string
      output?: string
    }
  | { type: 'tool_status'; id: string; status: AgentToolStatus; output?: string }
  | { type: 'warning'; id: string; text: string; detail?: string }
