import type { AgentActivityEvent, AgentQuestion } from '../agent'
import type { HarnessEvent, HarnessSessionEvent, TurnReceipt } from '../harness'
import { createDisplayActivity, reduceActivity } from './activityReducer'
import { displayActivities } from './activityLifecycle'
import type { DisplayMessage } from './types'

interface TurnView { role: string; activityId: string; assistantId: string | null; streams: Map<string, string> }

/** UI projection of the native journal. It contains no model history or execution decisions. */
export function projectSession(events: readonly HarnessSessionEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = []
  const turns = new Map<string, TurnView>()
  const byId = (id: string) => messages.find((message) => message.id === id)
  const text = (turn: TurnView, delta: string) => {
    if (!delta) return
    if (!turn.assistantId) {
      turn.assistantId = `assistant:${turn.activityId}:${messages.length}`
      messages.push({ id: turn.assistantId, role: 'assistant', text: '' })
    }
    byId(turn.assistantId)!.text += delta
  }
  const activity = (turn: TurnView, event: AgentActivityEvent) => {
    const message = byId(turn.activityId)
    if (message?.activity) message.activity = reduceActivity(message.activity, event)
  }
  const apply = (turn: TurnView, event: HarnessEvent | { kind: 'debug'; text: string }, id: string) => {
    if (event.kind === 'text') text(turn, event.text)
    else if (event.kind === 'activity') activity(turn, event.activity)
    else if (event.kind === 'debug') messages.push({ id: `debug:${id}`, role: 'debug', text: event.text })
    else if (event.kind === 'question') {
      const question: AgentQuestion = event.question
      messages.push({ id: `question:${question.requestId ?? id}`, role: 'assistant', text: '', question: {
        ...question, engineId: turn.role === 'project' ? 'project-harness' : 'canvas-harness',
      } })
      turn.assistantId = null
    }
  }
  for (const entry of events) {
    if (entry.kind === 'legacy_message') {
      const legacy = entry.data as unknown as DisplayMessage
      messages.push(...displayActivities([{ ...legacy, ...(legacy.question ? { question: { ...legacy.question, expired: !!legacy.question.requestId || legacy.question.expired } } : {}) }], false))
      continue
    }
    if (entry.kind === 'turn_begin' && entry.turnId) {
      if (typeof entry.data.replyTo === 'string') {
        const previous = byId(`question:${entry.data.replyTo}`)
        if (previous?.question) previous.question.answer = { text: String(entry.data.text ?? '') }
      }
      messages.push({ id: `user:${entry.turnId}`, role: 'user', text: String(entry.data.text ?? '') })
      const activityId = `activity:${entry.turnId}`
      messages.push({ id: activityId, role: 'system', text: '', activity: createDisplayActivity() })
      turns.set(entry.turnId, { role: String(entry.data.role), activityId, assistantId: null, streams: new Map() })
      continue
    }
    if (entry.kind === 'answer') {
      const message = messages.find((message) => message.question?.requestId === entry.data.interactionId)
      if (message?.question) message.question.answer = { text: Object.values(entry.data.answers as Record<string, string[]>).flat().join(', ') }
      continue
    }
    const turn = entry.turnId ? turns.get(entry.turnId) : null
    if (!turn) continue
    if (entry.kind === 'model_event') {
      const event = entry.data.event as HarnessEvent
      if (event.kind === 'text') {
        const request = String(entry.data.requestId)
        turn.streams.set(request, (turn.streams.get(request) ?? '') + event.text)
      }
      apply(turn, event, entry.id)
    } else if (entry.kind === 'model_result' && turn.role === 'project') {
      const receipt = entry.data.receipt as TurnReceipt
      const streamed = turn.streams.get(receipt.requestId) ?? ''
      if (receipt.status === 'completed' && receipt.text && !streamed.endsWith(receipt.text)) {
        text(turn, receipt.text.startsWith(streamed) ? receipt.text.slice(streamed.length) : receipt.text)
      }
    } else if (entry.kind === 'view') {
      apply(turn, entry.data.event as HarnessEvent, entry.id)
    } else if (entry.kind === 'turn_end') {
      const status = String(entry.data.status)
      const message = byId(turn.activityId)
      if (message?.activity) {
        if (status === 'interrupted') message.activity = { ...message.activity, status: 'interrupted',
          tools: message.activity.tools.map((tool) => tool.status === 'running' ? { ...tool, status: 'declined' } : tool) }
        else message.activity = reduceActivity(message.activity, { type: 'status', status: status === 'completed' ? 'completed' : 'failed' })
      }
      for (const message of messages) if (message.question?.requestId && !message.question.answer) message.question.expired = true
      if (entry.data.error) messages.push({ id: `error:${entry.turnId}`, role: 'system', text: String(entry.data.error) })
    }
  }
  return messages
}
