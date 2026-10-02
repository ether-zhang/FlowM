import { describe, expect, it } from 'vitest'
import { projectCanvasTurn } from './outputContract'

describe('projectCanvasTurn', () => {
  it('uses native final prose while preserving structured canvas operations', () => {
    const turn = projectCanvasTurn(
      {
        reply: 'Compressed structured reply',
        operations: [
          { op: 'create_geo', shape: 'rectangle', x: 10, y: 20, text: 'Scheduler' },
        ],
      },
      {
        callIdPrefix: 'claude-3',
        visibleText: '  ## Detailed explanation\n\n- Scheduler selects requests.  ',
      },
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
    const turn = projectCanvasTurn(
      { reply: 'Structured-only answer', operations: [] },
      { callIdPrefix: 'claude-1', visibleText: '   ' },
    )

    expect(turn.text).toBe('Structured-only answer')
    expect(turn.toolCalls).toEqual([])
  })
})
