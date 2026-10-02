import { useEffect, useState } from 'react'
import type { AgentModel } from '../agent'
import { harnessClient, type HarnessProfile } from '../harness'

interface CatalogState {
  key: string
  models: AgentModel[]
  loading: boolean
  error: string | null
}

/** Refresh on startup, executable/project change, or an explicit refresh click. */
export function useAgentModels(profile: HarnessProfile | null, enabled: boolean) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<CatalogState>({ key: '', models: [], loading: false, error: null })
  const profileId = profile?.id ?? ''
  const key = JSON.stringify([profileId, profile?.credentialVersion, profile?.signedIn, revision])
  useEffect(() => {
    if (!enabled || !profileId || !profile?.signedIn) return
    let current = true
    // Debounce path edits; StrictMode's initial cleanup also cancels its first probe.
    const timer = setTimeout(() => {
      setState({ key, models: [], loading: true, error: null })
      void harnessClient.models(profileId).then(
        (models) => {
          if (current) setState({ key, models, loading: false, error: models.length ? null : 'The agent returned an empty model catalog' })
        },
        (error) => {
          if (current) setState({ key, models: [], loading: false, error: error instanceof Error ? error.message : String(error) })
        },
      )
    }, 200)
    return () => { current = false; clearTimeout(timer) }
  }, [profileId, profile?.signedIn, enabled, key])
  const catalog = state.key === key ? state : { models: [], loading: enabled && !!profile?.signedIn, error: null }
  return { ...catalog, refresh: () => setRevision((value) => value + 1) }
}
