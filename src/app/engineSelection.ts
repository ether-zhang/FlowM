export type EngineId = 'canvas-harness' | 'project-harness'

/** Retired API/CLI selections continue through the corresponding private harness role. */
export function resolveEngineId(saved: string | null): EngineId {
  return saved === 'project-harness' || saved === 'codex' || saved === 'claude'
    ? 'project-harness'
    : 'canvas-harness'
}
