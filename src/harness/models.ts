import type { HarnessModelCatalog } from './types'

export function parseModelCatalog(value: unknown): HarnessModelCatalog {
  const catalog = value as Partial<HarnessModelCatalog> | null
  if (!catalog || typeof catalog.profileId !== 'string' || !Number.isSafeInteger(catalog.credentialVersion)
    || !['openai-account', 'openai-api', 'gateway'].includes(catalog.source ?? '')
    || !Array.isArray(catalog.models) || catalog.models.some((model) => !model || typeof model.id !== 'string' || !model.id || typeof model.label !== 'string')
    || (catalog.defaultModel !== null && typeof catalog.defaultModel !== 'string')) {
    throw new Error('Harness returned an invalid connection model catalog')
  }
  if (catalog.defaultModel && !catalog.models.some((model) => model.id === catalog.defaultModel)) throw new Error('Harness default model is absent from its catalog')
  return catalog as HarnessModelCatalog
}

/** A saved selection is only a preference; the connection's current catalog is authoritative. */
export function selectedHarnessModel(catalog: HarnessModelCatalog | null, preferred: string): string {
  if (!catalog) return ''
  if (preferred && catalog.models.some((model) => model.id === preferred)) return preferred
  return catalog.defaultModel ?? catalog.models[0]?.id ?? ''
}
