import { describe, expect, it } from 'vitest'
import { projectClaudeTurn } from './claudeAdapter'

describe('projectClaudeTurn', () => {
  it('uses native final prose while preserving structured canvas operations', () => {
    const turn = projectClaudeTurn(
      {
        reply: 'Compressed structured reply',
        operations: [
          { op: 'create_geo', shape: 'rectangle', x: 10, y: 20, text: 'Scheduler' },
        ],
      },
      '  ## Detailed explanation\n\n- Scheduler selects requests.  ',
      3,
    )

    expect(turn.text).toBe('## Detailed explanation\n\n- Scheduler selects requests.')
    expect(turn.toolCalls).toEqual([
      {
        id: 'claude-3-0',
        name: 'create_geo',
        args: { shape: 'rectangle', x: 10, y: 20, text: 'Scheduler' },
      },
    ])
  })

  it('falls back to the structured reply when no native final prose exists', () => {
    const turn = projectClaudeTurn(
      { reply: 'Structured-only answer', operations: [] },
      '   ',
      1,
    )

    expect(turn.text).toBe('Structured-only answer')
    expect(turn.toolCalls).toEqual([])
  })
})
