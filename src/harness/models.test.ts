import { describe, expect, it } from 'vitest'
import { parseModelCatalog, selectedHarnessModel } from './models'
import type { HarnessModelCatalog } from './types'

const account: HarnessModelCatalog = { profileId: 'p', credentialVersion: 2, source: 'openai-account', models: [{ id: 'available', label: 'Account model', origin: 'remote' }], defaultModel: 'available' }

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
  it('accepts an official kernel candidate without adding a free-form model path', () => {
    const current = parseModelCatalog({ ...account, models: [...account.models, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', origin: 'kernel' }] })
    expect(selectedHarnessModel(current, 'gpt-6.1-sol')).toBe('gpt-6.1-sol')
    expect(selectedHarnessModel(current, 'invented-model')).toBe('available')
    expect(() => parseModelCatalog({ ...account, models: [{ id: 'm', label: 'M' }] })).toThrow('invalid')
  })
})
