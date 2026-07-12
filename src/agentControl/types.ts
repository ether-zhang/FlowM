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
