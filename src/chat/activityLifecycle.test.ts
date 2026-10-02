import { describe, expect, it } from 'vitest'
import { createDisplayActivity, reduceActivity } from './activityReducer'
import { displayActivities, finishActivity } from './activityLifecycle'
import type { DisplayMessage } from './types'

const working = (): DisplayMessage => ({ id: 'activity', role: 'system', text: '', activity: reduceActivity({ ...createDisplayActivity(), label: 'Working...' }, { type: 'tool', id: 'read', name: 'Read', status: 'running' }) })
const user: DisplayMessage = { id: 'user', role: 'user', text: 'Draw the flow' }
const answer: DisplayMessage = { id: 'answer', role: 'assistant', text: 'The diagram is complete.' }

describe('UI request activity lifecycle', () => {
  it('settles the aggregate card after a successful request without a provider completion event', () => {
    const messages = [user, working(), answer]
    const result = finishActivity(messages, 'activity', 'completed')
    expect(result[1].activity?.status).toBe('completed')
    expect(result[1].activity?.label).toBeUndefined()
    expect(result[1].activity?.tools[0].status).toBe('completed')
    expect(result[0]).toBe(user)
    expect(result[2]).toBe(answer)
    expect(messages[1].activity?.status).toBe('working')
  })

  it('keeps a failed request visibly failed', () => {
    const result = finishActivity([working()], 'activity', 'failed')
    expect(result[0].activity?.status).toBe('failed')
    expect(result[0].activity?.tools[0].status).toBe('failed')
  })

  it('shows old saved working cards as completed when the same request has a final answer', () => {
    const result = displayActivities([user, working(), answer], false)
    expect(result[1].activity?.status).toBe('completed')
  })

  it('shows an unfinished restored request as stopped, preserving its saved data', () => {
    const saved = working()
    const result = displayActivities([user, saved], false)
    expect(result[1].activity?.status).toBe('interrupted')
    expect(result[1].activity?.tools[0].status).toBe('declined')
    expect(saved.activity?.status).toBe('working')
  })

  it('animates only the active request while leaving earlier finished cards settled', () => {
    const active = { ...working(), id: 'new-activity' }
    const messages = [user, working(), answer, { ...user, id: 'new-user' }, active]
    const result = displayActivities(messages, true)
    expect(result[1].activity?.status).toBe('completed')
    expect(result[4]).toBe(active)
    expect(result[4].activity?.status).toBe('working')
  })

  it('does not revive an old card while a new request has not emitted activity yet', () => {
    const result = displayActivities([user, working(), answer, { ...user, id: 'new-user' }], true)
    expect(result[1].activity?.status).toBe('completed')
  })
})
