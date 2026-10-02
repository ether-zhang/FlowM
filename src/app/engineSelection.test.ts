import { describe, expect, it } from 'vitest'
import { resolveEngineId } from './engineSelection'

describe('desktop engine selection', () => {
  it.each(['canvas', 'canvas-codex', 'canvas-claude'])('migrates retired %s to Canvas Assistant', (saved) => {
    expect(resolveEngineId(saved)).toBe('canvas-harness')
  })

  it.each(['codex', 'claude'])('migrates retired %s to Project Agent', (saved) => {
    expect(resolveEngineId(saved)).toBe('project-harness')
  })

  it.each(['canvas-harness', 'project-harness'] as const)('preserves %s', (saved) => {
    expect(resolveEngineId(saved)).toBe(saved)
  })

  it.each([null, '', 'unknown'])('defaults %s to Canvas Assistant', (saved) => {
    expect(resolveEngineId(saved)).toBe('canvas-harness')
  })
})
