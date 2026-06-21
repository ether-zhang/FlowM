export type DisplayRole = 'user' | 'assistant' | 'system' | 'debug'

/** A message as shown in the right-hand chat panel (distinct from the API history). */
export interface DisplayMessage {
  id: string
  role: DisplayRole
  text: string
}
