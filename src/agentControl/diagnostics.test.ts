import { describe, expect, it } from 'vitest'
import { cleanAgentDiagnostic } from './diagnostics'

describe('agent diagnostics', () => {
  it('removes ANSI formatting and drops whitespace-only lines', () => {
    expect(cleanAgentDiagnostic('\u001b[31mERROR\u001b[0m')).toBe('ERROR')
    expect(cleanAgentDiagnostic('   ')).toBe('')
  })
})
