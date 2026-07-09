import { describe, expect, it } from 'vitest'
import { canvasTools, declareStructureTool } from '../protocol'
import { buildCodexOpsSchema } from './codexAdapter'

describe('buildCodexOpsSchema', () => {
  it('marks every object schema as closed for Codex structured outputs', () => {
    const schema = buildCodexOpsSchema([...canvasTools, declareStructureTool])
    const openObjects: string[] = []

    const walk = (value: unknown, path: string) => {
      if (!value || typeof value !== 'object') return
      const obj = value as Record<string, unknown>
      if (obj.type === 'object' && obj.additionalProperties !== false) openObjects.push(path)
      for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`)
    }

    walk(schema, '$')
    expect(openObjects).toEqual([])
  })

  it('exposes a nullable question channel for assistant confirmations', () => {
    const schema = buildCodexOpsSchema([...canvasTools, declareStructureTool]) as {
      required?: string[]
      properties?: Record<string, unknown>
    }

    expect(schema.required).toContain('question')
    expect(schema.properties?.question).toMatchObject({
      type: ['object', 'null'],
      additionalProperties: false,
    })
  })

})
