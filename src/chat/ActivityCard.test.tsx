import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { uiText } from '../app/uiText'
import { ActivityCard } from './ActivityCard'
import { createDisplayActivity, reduceActivity } from './activityReducer'

describe('ActivityCard', () => {
  it('renders working state, collapsible thinking, and tool detail', () => {
    let activity = reduceActivity(createDisplayActivity(), {
      type: 'thinking_delta', id: 'reasoning', delta: 'Inspecting the repository',
    })
    activity = reduceActivity(activity, {
      type: 'tool', id: 'read', name: 'Read', detail: 'src/app.ts', status: 'running',
    })
    const html = renderToStaticMarkup(<ActivityCard activity={activity} text={uiText.en} />)
    expect(html).toContain('<details class="msg msg-activity activity-working" open="">')
    expect(html).toContain('Thinking')
    expect(html).toContain('Inspecting the repository')
    expect(html).toContain('src/app.ts')
  })

  it('collapses the group after completion', () => {
    const activity = reduceActivity(createDisplayActivity(), {
      type: 'status', status: 'completed',
    })
    const html = renderToStaticMarkup(<ActivityCard activity={activity} text={uiText.en} />)
    expect(html).toContain('activity-completed')
    expect(html).toContain('Worked')
    expect(html).not.toContain(' open=""')
  })

  it('collapses a consecutive mixed-tool stage behind one summary', () => {
    let activity = reduceActivity(createDisplayActivity(), {
      type: 'tool', id: 'glob', name: 'Glob', status: 'completed',
    })
    activity = reduceActivity(activity, {
      type: 'tool', id: 'read', name: 'Read', status: 'completed', detail: 'src/app.ts',
    })
    const html = renderToStaticMarkup(<ActivityCard activity={activity} text={uiText.en} />)

    expect(html).toContain('Ran 2 actions')
    expect(html).toContain('activity-tool-list')
  })
})
