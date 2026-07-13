import { describe, expect, it } from 'vitest'
import { createDisplayActivity } from './activityReducer'
import { groupMessages } from './messageGrouping'

describe('chat message grouping', () => {
  it('keeps structured agent activity out of legacy yellow system groups', () => {
    const activity = createDisplayActivity()
    const items = groupMessages([{
      id: 'activity-1',
      role: 'system',
      text: '',
      activity,
    }])
    expect(items).toEqual([{
      type: 'msg',
      m: { id: 'activity-1', role: 'system', text: '', activity },
    }])
  })
})
