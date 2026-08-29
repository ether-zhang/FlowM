import { describe, expect, it } from 'vitest'
import { diagramPlanCounts, diagramPlanRefs, parseDiagramPlan } from './diagram'

function refs(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`)
}

describe('diagram plan contract', () => {
  it('accepts one balanced mixed plan and exposes its declared refs', () => {
    const parsed = parseDiagramPlan({
      kind: 'mixed',
      focus: 'Steady-state allocation, mapping, reuse, and release.',
      regions: [
        {
          ref: 'runtime',
          kind: 'process',
          purpose: 'Request lifecycle.',
          primaryRefs: refs('step', 8),
          supportingRefs: ['runtime-frame'],
        },
        {
          ref: 'storage',
          kind: 'structure',
          purpose: 'Ownership and physical storage.',
          primaryRefs: refs('store', 7),
          supportingRefs: ['storage-frame'],
        },
      ],
    })

    expect(parsed.errors).toEqual([])
    expect(parsed.plan).not.toBeNull()
    expect(diagramPlanCounts(parsed.plan!)).toEqual({ primary: 15, supporting: 2 })
    expect(diagramPlanRefs(parsed.plan!)).toContain('runtime-frame')
    expect(diagramPlanRefs(parsed.plan!)).toContain('store-7')
  })

  it('requires both semantic region kinds for a mixed plan', () => {
    const parsed = parseDiagramPlan({
      kind: 'mixed',
      focus: 'Runtime only.',
      regions: [{
        ref: 'runtime',
        kind: 'process',
        purpose: 'Lifecycle.',
        primaryRefs: ['a', 'b'],
      }],
    })

    expect(parsed.plan).toBeNull()
    expect(parsed.errors.join(' ')).toContain(
      'mixed diagrams require at least one process region and one structure region',
    )
  })

  it('does not impose a node quota at the shared protocol boundary', () => {
    const parsed = parseDiagramPlan({
      kind: 'mixed',
      focus: 'An over-expanded mechanism.',
      regions: [
        {
          ref: 'runtime',
          kind: 'process',
          purpose: 'Lifecycle.',
          primaryRefs: refs('step', 12),
        },
        {
          ref: 'storage',
          kind: 'structure',
          purpose: 'Storage.',
          primaryRefs: refs('store', 7),
        },
      ],
    })

    expect(parsed.errors).toEqual([])
    expect(parsed.plan).not.toBeNull()
    expect(diagramPlanCounts(parsed.plan!)).toEqual({ primary: 19, supporting: 0 })
  })

  it('rejects a shape ref assigned to more than one region', () => {
    const parsed = parseDiagramPlan({
      kind: 'mixed',
      focus: 'Ambiguous ownership.',
      regions: [
        {
          ref: 'runtime',
          kind: 'process',
          purpose: 'Lifecycle.',
          primaryRefs: ['shared'],
        },
        {
          ref: 'storage',
          kind: 'structure',
          purpose: 'Storage.',
          primaryRefs: ['shared'],
        },
      ],
    })

    expect(parsed.plan).toBeNull()
    expect(parsed.errors.join(' ')).toContain('shape ref shared is assigned more than once')
  })
})
