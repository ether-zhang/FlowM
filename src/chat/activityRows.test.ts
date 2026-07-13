import { describe, expect, it } from 'vitest'
import { createDisplayActivity, reduceActivity } from './activityReducer'
import { activityRows, commandLabel } from './activityRows'

describe('activity rows', () => {
  it('preserves event order and folds adjacent mixed tools into one stage', () => {
    let activity = reduceActivity(createDisplayActivity(), {
      type: 'thinking_delta', id: 'think-1', delta: 'Inspect repository',
    })
    activity = reduceActivity(activity, {
      type: 'tool', id: 'cmd-1', name: 'Command', toolKind: 'command', status: 'completed', detail: 'rg cache',
    })
    activity = reduceActivity(activity, {
      type: 'tool', id: 'read-1', name: 'Read', status: 'completed', detail: 'src/app.ts',
    })
    activity = reduceActivity(activity, {
      type: 'commentary_delta', id: 'note-1', delta: 'Found the path',
    })
    activity = reduceActivity(activity, {
      type: 'tool', id: 'cmd-3', name: 'Command', toolKind: 'command', status: 'running', detail: 'npm test',
    })

    expect(activityRows(activity).map((row) => row.kind)).toEqual([
      'thinking', 'tools', 'commentary', 'tool',
    ])
    expect(activityRows(activity)[1]).toMatchObject({ kind: 'tools', tools: [{ id: 'cmd-1' }, { id: 'read-1' }] })
  })

  it('unwraps shell command wrappers and truncates long labels', () => {
    expect(commandLabel('powershell.exe -Command "Get-Content src/app.ts"')).toBe('Get-Content src/app.ts')
    expect(commandLabel('x'.repeat(140))).toHaveLength(120)
  })
})
