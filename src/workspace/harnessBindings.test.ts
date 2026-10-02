import { describe, expect, it } from 'vitest'
import { continuationContext, harnessBindingKey } from './harnessBindings'
import type { HarnessProfile } from '../harness'

const profile: HarnessProfile = { id: 'p', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', authKind: 'chatgpt', credentialVersion: 1, account: null, subject: null, clientId: null }
describe('FlowM session migration boundaries', () => {
  it('separates model, credential and role changes into independent native bindings', () => {
    const key = harnessBindingKey(profile, 'canvas')
    expect(harnessBindingKey(profile, 'project')).not.toBe(key)
    expect(harnessBindingKey({ ...profile, credentialVersion: 2 }, 'canvas')).not.toBe(key)
    expect(harnessBindingKey({ ...profile, model: 'claude' }, 'canvas')).not.toBe(key)
  })
  it('continues from old visible conversation without replaying debug output or dead interactions', () => {
    const context = continuationContext([
      { id: 'u', role: 'user', text: 'Diagram the queue' },
      { id: 'a', role: 'assistant', text: 'Queue has two stages' },
      { id: 'd', role: 'debug', text: 'structured internal payload' },
      { id: 'q', role: 'assistant', text: 'old approval', question: { engineId: 'canvas-codex', requestId: 'dead' } },
    ])
    expect(context).toBe('user: Diagram the queue\n\nassistant: Queue has two stages')
  })
})
