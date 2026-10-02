import { describe, expect, it } from 'vitest'
import { parseModelCatalog, selectedHarnessModel } from './models'
import type { HarnessModelCatalog } from './types'

const account: HarnessModelCatalog = { profileId: 'p', credentialVersion: 2, source: 'openai-account', models: [{ id: 'available', label: 'Account model' }], defaultModel: 'available' }

describe('connection-owned model catalog', () => {
  it('rejects the old unscoped adapter list', () => {
    expect(() => parseModelCatalog([{ id: 'old-cli-model', label: 'CLI model' }])).toThrow('invalid')
  })
  it('selects the native catalog default instead of an obsolete saved model', () => {
    expect(selectedHarnessModel(account, 'gpt-obsolete')).toBe('available')
    expect(selectedHarnessModel(null, 'gpt-obsolete')).toBe('')
  })
  it('never selects a model missing from the current upstream catalog', () => {
    expect(selectedHarnessModel({ ...account, source: 'gateway' }, 'claude-explicit')).toBe('available')
    expect(selectedHarnessModel(account, 'gpt-6.1-sol')).toBe('available')
    expect(selectedHarnessModel(account, 'available')).toBe('available')
    expect(selectedHarnessModel({ ...account, models: [], defaultModel: null }, 'gpt-6.1-sol')).toBe('')
  })
  it('refuses an invented default that is absent from the connection catalog', () => {
    expect(() => parseModelCatalog({ ...account, defaultModel: 'bundled-default' })).toThrow('absent')
  })
})
