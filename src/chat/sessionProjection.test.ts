import { describe, expect, it } from 'vitest'
import { projectSession } from './sessionProjection'
import type { HarnessSessionEvent } from '../harness'

const row = (sequence: number, kind: string, data: Record<string, unknown>, turnId: string | null = 'u'): HarnessSessionEvent => ({ sequence, kind, data, turnId, id: `event-${sequence}`, timestamp: 1 })
describe('native conversation UI projection', () => {
  it('reconstructs partial model text, final text and terminal activity without duplication', () => {
    const events = [row(1, 'turn_begin', { role: 'project', text: 'Work' }),
      row(2, 'model_event', { requestId: 'r', event: { kind: 'text', text: 'Hello ' } }),
      row(3, 'model_result', { receipt: { requestId: 'r', status: 'completed', text: 'Hello world' } }),
      row(4, 'turn_end', { status: 'completed' })]
    const messages = projectSession(events)
    expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text).join('')).toBe('Hello world')
    expect(messages.find((message) => message.activity)?.activity?.status).toBe('completed')
    expect(projectSession(events)).toEqual(messages)
  })
  it('keeps canvas JSON internal and displays the framework final explanation', () => {
    const messages = projectSession([row(1, 'turn_begin', { role: 'canvas', text: 'Draw' }),
      row(2, 'model_result', { receipt: { status: 'completed', text: '{"operations":[{"op":"create_geo"}]}' } }),
      row(3, 'view', { event: { kind: 'text', text: 'Diagram explanation' } }), row(4, 'turn_end', { status: 'completed' })])
    expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual(['Diagram explanation'])
  })
  it('restores returned model errors and a failed activity after the conversation is reopened', () => {
    const error = '403: The selected model is not available for this account'
    const messages = projectSession([row(1, 'turn_begin', { role: 'canvas', text: 'Draw' }),
      row(2, 'model_event', { event: { kind: 'activity', activity: { type: 'warning', id: 'model-error', text: error } } }),
      row(3, 'turn_end', { status: 'failed', error })])
    expect(messages.find((message) => message.activity)?.activity).toMatchObject({
      status: 'failed', warnings: [{ id: 'model-error', text: error }],
    })
    expect(messages.find((message) => message.id === 'error:u')?.text).toBe(error)
  })
  it('expires native questions and stops running tools after a recovered interruption', () => {
    const messages = projectSession([row(1, 'turn_begin', { role: 'project', text: 'Edit' }),
      row(2, 'model_event', { event: { kind: 'activity', activity: { type: 'tool', id: 'cmd', name: 'Command', status: 'running' } } }),
      row(3, 'model_event', { event: { kind: 'question', question: { requestId: 'approve', items: [{ id: 'decision', prompt: 'Allow?' }] } } }),
      row(4, 'turn_end', { status: 'interrupted', error: 'Stopped without replay' })])
    expect(messages.find((message) => message.question)?.question?.expired).toBe(true)
    expect(messages.find((message) => message.activity)?.activity).toMatchObject({ status: 'interrupted', tools: [{ status: 'declined' }] })
  })
  it('restores confirmed native answers and design answers as conversation records', () => {
    const messages = projectSession([row(1, 'turn_begin', { role: 'canvas', text: 'Draw' }),
      row(2, 'view', { event: { kind: 'question', question: { items: [{ id: 'direction', prompt: 'Left or right?' }] } } }),
      row(3, 'turn_end', { status: 'completed' }),
      row(4, 'turn_begin', { role: 'canvas', text: 'Left', replyTo: 'event-2' }, 'next'),
      row(5, 'model_event', { event: { kind: 'question', question: { requestId: 'q', items: [{ id: 'ok', prompt: 'Continue?' }] } } }, 'next'),
      row(6, 'answer', { interactionId: 'q', answers: { ok: ['Yes'] } }, null), row(7, 'turn_end', { status: 'completed' }, 'next')])
    expect(messages.filter((message) => message.question).map((message) => message.question?.answer?.text)).toEqual(['Left', 'Yes'])
  })
})
