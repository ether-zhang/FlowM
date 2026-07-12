import type { AgentQuestionItem } from '../agentControl'

export type DisplayRole = 'user' | 'assistant' | 'system' | 'debug'

export interface DisplayQuestion {
  requestId?: string
  items?: AgentQuestionItem[]
  /** Compatibility with questions persisted before native agent control. */
  prompt?: string
  engineId: string
  answer?: {
    text: string
  }
}

/** A message as shown in the right-hand chat panel (distinct from the API history). */
export interface DisplayMessage {
  id: string
  role: DisplayRole
  text: string
  /** Optional image (PNG data URL) — used by debug messages to show what was sent. */
  image?: string
  /** Optional active-agent question; rendered as yes/no/other controls in the chat panel. */
  question?: DisplayQuestion
}
