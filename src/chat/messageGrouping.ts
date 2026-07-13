import { isSystemErrorNote } from '../app/uiText'
import type { DisplayMessage } from './types'

export type RenderItem =
  | { type: 'msg'; m: DisplayMessage }
  | { type: 'sysgroup'; id: string; notes: DisplayMessage[] }

/** Fold consecutive legacy system notes without consuming structured activity messages. */
export function groupMessages(messages: DisplayMessage[]): RenderItem[] {
  const items: RenderItem[] = []
  for (const message of messages) {
    if (
      message.role === 'system'
      && !message.activity
      && !message.question
      && !isSystemErrorNote(message.text)
    ) {
      const last = items[items.length - 1]
      if (last && last.type === 'sysgroup') last.notes.push(message)
      else items.push({ type: 'sysgroup', id: message.id, notes: [message] })
    } else {
      items.push({ type: 'msg', m: message })
    }
  }
  return items
}
