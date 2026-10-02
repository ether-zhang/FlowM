import type { DisplayMessage } from '../chat/types'
import type { HarnessProfile } from '../harness'

/** Stable keys prevent credential, model, or permission changes from reusing an old thread. */
export function harnessBindingKey(profile: HarnessProfile, role: 'canvas' | 'project'): string {
  return JSON.stringify([profile.id, profile.credentialVersion, role, profile.model])
}

/** Existing FlowM display data remains useful even when its old CLI resume ID cannot be run. */
export function continuationContext(messages: DisplayMessage[]): string {
  return messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && !message.question && message.text.trim())
    .map((message) => `${message.role}: ${message.text}`)
    .join('\n\n')
    .slice(-32_000)
}
