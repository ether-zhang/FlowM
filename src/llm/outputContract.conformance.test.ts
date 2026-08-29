import { describe, expect, it } from 'vitest'
import { projectCanvasTurn } from './outputContract'

describe('canvas turn output conformance', () => {
  it('projects portable and strict envelopes to the same operation turn', () => {
    const portable = projectCanvasTurn({
      reply: 'Created the scheduler.',
      operations: [{ op: 'create_geo', shape: 'rectangle', text: 'Scheduler' }],
    }, { callIdPrefix: 'turn' })
    const strict = projectCanvasTurn({
      reply: 'Created the scheduler.',
      question: null,
      operations: [{
        op: 'create_geo',
        shape: 'rectangle',
        text: 'Scheduler',
        x: null,
        y: null,
        w: null,
        h: null,
        ref: null,
      }],
    }, { callIdPrefix: 'turn' })

    expect(strict).toEqual(portable)
  })

  it('projects portable and strict envelopes to the same question turn', () => {
    const portable = projectCanvasTurn({
      question: { prompt: 'Use a vertical layout?' },
      operations: [],
    }, { callIdPrefix: 'turn' })
    const strict = projectCanvasTurn({
      reply: '',
      question: { prompt: 'Use a vertical layout?' },
      operations: [],
    }, { callIdPrefix: 'turn' })

    expect(strict).toEqual(portable)
  })

  it('projects portable and strict diagram declarations to the same tool call', () => {
    const base = {
      op: 'declare_diagram',
      kind: 'mixed',
      focus: 'Allocation and storage.',
      regions: [
        {
          ref: 'runtime',
          kind: 'process',
          purpose: 'Lifecycle.',
          primaryRefs: ['request', 'allocate'],
        },
        {
          ref: 'storage',
          kind: 'structure',
          purpose: 'Storage.',
          primaryRefs: ['pool', 'pages'],
        },
      ],
    }
    const portable = projectCanvasTurn({ operations: [base] }, { callIdPrefix: 'turn' })
    const strict = projectCanvasTurn({
      reply: '',
      question: null,
      operations: [{
        ...base,
        regions: base.regions.map((region) => ({ ...region, supportingRefs: null })),
      }],
    }, { callIdPrefix: 'turn' })

    expect(strict).toEqual(portable)
  })
})
