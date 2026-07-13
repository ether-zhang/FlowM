import { describe, expect, it } from 'vitest'
import { canvasTools, declareStructureTool } from '../protocol'
import { buildCodexOpsSchema, parseCodexCanvasCommentary } from './codexAdapter'

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

describe('parseCodexCanvasCommentary', () => {
  it('projects only the reply from a complete structured commentary item', () => {
    expect(parseCodexCanvasCommentary(JSON.stringify({
      reply: 'Inspecting the scheduler', question: null, operations: [],
    }))).toBe('Inspecting the scheduler')
  })

  it('does not infer commentary from unstructured text or partial JSON', () => {
    expect(parseCodexCanvasCommentary('Inspecting the scheduler')).toBeNull()
    expect(parseCodexCanvasCommentary('{"reply":"Inspecting"')).toBeNull()
  })
})
