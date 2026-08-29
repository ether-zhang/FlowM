import { describe, expect, it } from 'vitest'
import { FLOWM_CANVAS_SYSTEM_PROMPT } from './canvasPrompt'

describe('canvas semantic contract', () => {
  it('defines one root decision for process, structure, and mixed diagrams', () => {
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain('## Root diagram command')
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain('top-to-bottom flowchart')
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain('flow dir:down')
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain('structural diagram organized by those relationships')
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain('Apply the structural rule inside structure regions')
  })

  it('does not encode provider-specific drawing preferences', () => {
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).not.toMatch(/Codex-specific|running through Codex/i)
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).not.toMatch(/Claude-specific|running through Claude/i)
  })

  it('uses one balanced density policy and one symbolic-reference contract', () => {
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain('balanced semantic density')
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain(
      'smallest set of primary nodes that preserves every responsibility',
    )
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).not.toMatch(/\b\d+\s*[-–]\s*\d+\b/)
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).not.toContain('at most one supporting')
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain('existing id or by a create ref')
  })

  it('requires one machine-checkable root plan for non-trivial diagrams', () => {
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain('exactly one `declare_diagram` operation')
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain('steady-state causal mechanism')
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain('primaryRefs')
    expect(FLOWM_CANVAS_SYSTEM_PROMPT).toContain('supportingRefs')
  })
})
