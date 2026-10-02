import { describe, expect, it } from 'vitest'
import { canvasTools, declareDiagramTool, declareStructureTool } from '../protocol'
import { buildCanvasTurnOutputSchema, projectCanvasTurn } from './outputContract'

describe('strict canvas turn output schema shared by harness providers', () => {
  it('marks every object schema as closed for Codex structured outputs', () => {
    const schema = buildCanvasTurnOutputSchema(
      [declareDiagramTool, ...canvasTools, declareStructureTool],
      'strict',
    )
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
    const schema = buildCanvasTurnOutputSchema(
      [declareDiagramTool, ...canvasTools, declareStructureTool],
      'strict',
    ) as {
      required?: string[]
      properties?: Record<string, unknown>
    }

    expect(schema.required).toContain('question')
    expect(schema.properties?.question).toMatchObject({
      type: ['object', 'null'],
      additionalProperties: false,
    })
  })

  it('closes nested diagram-plan regions and makes optional fields nullable', () => {
    const schema = buildCanvasTurnOutputSchema([declareDiagramTool], 'strict') as {
      properties: {
        operations: {
          items: {
            properties: {
              regions: {
                items: {
                  required: string[]
                  additionalProperties: boolean
                  properties: { supportingRefs: { type: string[] } }
                }
              }
            }
          }
        }
      }
    }
    const region = schema.properties.operations.items.properties.regions.items

    expect(region.additionalProperties).toBe(false)
    expect(region.required).toContain('supportingRefs')
    expect(region.properties.supportingRefs.type).toEqual(['array', 'null'])
  })

  it('derives operation properties from ToolDef instead of a hard-coded field list', () => {
    const schema = buildCanvasTurnOutputSchema([
      {
        name: 'custom_op',
        description: 'test',
        parameters: {
          type: 'object',
          properties: { customField: { type: 'string' } },
          required: ['customField'],
        },
      },
    ], 'strict') as {
      properties: { operations: { items: { properties: Record<string, unknown>; required: string[] } } }
    }

    expect(schema.properties.operations.items.properties).toHaveProperty('customField')
    expect(schema.properties.operations.items.required).toContain('customField')
  })

  it('strips strict-schema null placeholders before projecting operations', () => {
    const turn = projectCanvasTurn({
      reply: '',
      question: null,
      operations: [{ op: 'create_geo', shape: 'rectangle', x: null, y: null, text: 'A' }],
    }, { callIdPrefix: 'codex-2' })

    expect(turn.toolCalls).toEqual([{
      id: 'codex-2-0',
      name: 'create_geo',
      args: { shape: 'rectangle', text: 'A' },
    }])
  })

  it('represents a no-tools phase without an invalid empty operation enum', () => {
    const schema = buildCanvasTurnOutputSchema([], 'strict') as {
      properties: { operations: { maxItems?: number; items?: unknown } }
    }

    expect(schema.properties.operations.maxItems).toBe(0)
    expect(JSON.stringify(schema)).not.toContain('"enum":[]')
  })

})
