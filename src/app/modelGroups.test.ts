import { describe, expect, it } from 'vitest'
import { groupModelsByPublisher } from './modelGroups'
import type { HarnessModel } from '../harness'
const model = (id: string, label: string): HarnessModel => ({ id, label, origin: 'remote' })

describe('publisher ordering for gateway models', () => {
  it('groups by returned publisher and orders publishers and model names without changing IDs', () => {
    const models = [model('openai/b', 'OpenAI: Model 10'), model('google/g', 'Google: Gemini'),
      model('anthropic/c', 'Anthropic: Claude'), model('openai/a', 'OpenAI: Model 2')]
    const snapshot = structuredClone(models)
    const groups = groupModelsByPublisher(models, 'Other')
    expect(groups.map((group) => group.label)).toEqual(['Anthropic', 'Google', 'OpenAI'])
    expect(groups[2].models.map((model) => model.id)).toEqual(['openai/a', 'openai/b'])
    expect(models).toEqual(snapshot)
    expect(groups.flatMap((group) => group.models).map((model) => model.id).toSorted()).toEqual(models.map((model) => model.id).toSorted())
  })
  it('uses a supplied publisher label or keeps unspecified routes in the final group', () => {
    const groups = groupModelsByPublisher([model('default', 'Default route'), model('claude-alias', 'Anthropic: Alias')], '其他')
    expect(groups.map((group) => group.label)).toEqual(['Anthropic', '其他'])
  })
})
