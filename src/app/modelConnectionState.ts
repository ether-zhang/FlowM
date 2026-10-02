import type { HarnessProfile } from '../harness'

export type ModelConnectionOption = 'gpt' | 'claude' | 'gateway'

export function connectionOption(profile: HarnessProfile): ModelConnectionOption {
  return profile.kind === 'gateway' ? 'gateway' : 'gpt'
}

/** Undefined migrates existing UI preferences; null records an explicit disconnection. */
export function activeModelConnection(profiles: HarnessProfile[], preferredId: string, connectedId: string | null | undefined): HarnessProfile | null {
  if (connectedId === null) return null
  if (connectedId !== undefined) return profiles.find((profile) => profile.id === connectedId && profile.signedIn) ?? null
  return profiles.find((profile) => profile.id === preferredId && profile.signedIn)
    ?? profiles.find((profile) => profile.signedIn && profile.authKind !== 'none')
    ?? null
}
