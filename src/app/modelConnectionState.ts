import type { HarnessProfile } from '../harness'

export type ModelConnectionOption = 'gpt' | 'claude' | 'gateway'

export function connectionOption(profile: HarnessProfile): ModelConnectionOption {
  return profile.kind === 'gateway' ? 'gateway' : 'gpt'
}
