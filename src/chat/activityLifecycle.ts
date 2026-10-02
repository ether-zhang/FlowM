import { reduceActivity } from './activityReducer'
import type { DisplayMessage } from './types'

/** The UI request owns the aggregate card across all canvas build/review/finalize turns. */
export function finishActivity(messages: DisplayMessage[], id: string | null, status: 'completed' | 'failed'): DisplayMessage[] {
  return messages.map((message) => message.id === id && message.activity
    ? { ...message, activity: { ...reduceActivity(message.activity, { type: 'status', status }), label: undefined } }
    : message)
}

/** Persisted cards cannot represent live work after reload. An answer confirms completion;
 *  an unfinished saved request is shown as stopped instead of spinning indefinitely. */
export function displayActivities(messages: DisplayMessage[], busy: boolean): DisplayMessage[] {
  const lastUser = messages.findLastIndex((message) => message.role === 'user')
  const active = busy ? messages.findLast((message, index) => index > lastUser && message.activity?.status === 'working')?.id : undefined
  let answerAfter = false
  return messages.toReversed().map((message) => {
    if (message.role === 'user') answerAfter = false
    else if (message.role === 'assistant' && message.text.trim() && !message.question) answerAfter = true
    if (message.activity?.status !== 'working' || message.id === active) return message
    const activity = answerAfter
      ? reduceActivity(message.activity, { type: 'status', status: 'completed' })
      : { ...message.activity, status: 'interrupted' as const, tools: message.activity.tools.map((tool) => tool.status === 'running' ? { ...tool, status: 'declined' as const } : tool) }
    return { ...message, activity: { ...activity, label: undefined } }
  }).toReversed()
}
