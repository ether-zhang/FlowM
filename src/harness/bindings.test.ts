import { describe, expect, it } from 'vitest'
import { continuationContext, harnessBindingKey } from './bindings'
import type { HarnessConnection } from '../harness'

const profile: HarnessConnection = { profileId: "p", model: "m", credentialVersion: 1 }
describe('FlowM session migration boundaries', () => {
  it('separates model, credential and role changes into independent native bindings', () => {
    const key = harnessBindingKey(profile, 'canvas')
    expect(harnessBindingKey(profile, 'project')).not.toBe(key)
    expect(harnessBindingKey({ ...profile, credentialVersion: 2 }, 'canvas')).not.toBe(key)
    expect(harnessBindingKey({ ...profile, model: 'claude' }, 'canvas')).not.toBe(key)
  })
  it('continues from old visible conversation without replaying debug output or dead interactions', () => {
    const context = continuationContext([
      { role: 'user', text: 'Diagram the queue' },
      { role: 'assistant', text: 'Queue has two stages' },
      { role: 'debug', text: 'structured internal payload' },
      { role: 'assistant', text: 'old approval', question: { engineId: 'canvas-codex', requestId: 'dead' } },
    ])
    expect(context).toBe('user: Diagram the queue\n\nassistant: Queue has two stages')
  })
})
