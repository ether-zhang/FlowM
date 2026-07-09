export type DisplayRole = 'user' | 'assistant' | 'system' | 'debug'
export type QuestionChoice = 'yes' | 'no' | 'other'

export interface DisplayQuestion {
  prompt: string
  engineId: string
  answer?: {
    choice: QuestionChoice
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
