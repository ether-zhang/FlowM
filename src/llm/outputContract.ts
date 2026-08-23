import type { ToolDef } from '../protocol'
import { normalizeLlmQuestion } from './questions'
import type { LlmToolCall, LlmTurn } from './types'

type JsonSchema = Record<string, unknown>

export type OutputSchemaProfile = 'portable' | 'strict'

export interface ProjectTurnOptions {
  callIdPrefix: string
  /** Provider-native final prose, when that transport exposes it separately. */
  visibleText?: string
}

/**
 * Build the one FlowM canvas-turn envelope from the provider-neutral ToolDef list.
 * `portable` keeps optional fields optional. `strict` closes every object and represents
 * optional fields as required nullable properties for OpenAI Structured Outputs.
 */
export function buildCanvasTurnOutputSchema(
  tools: ToolDef[],
  profile: OutputSchemaProfile,
): JsonSchema {
  const operation = mergedOperationSchema(tools)
  const question: JsonSchema = {
    type: 'object',
    description:
      'Set this only when you need the user to confirm or choose before continuing. If set, keep operations empty.',
    properties: {
      prompt: {
        type: 'string',
        description: 'The concise yes/no/other question shown to the user.',
      },
    },
    required: ['prompt'],
  }

  if (profile === 'portable') {
    return {
      type: 'object',
      properties: {
        reply: {
          type: 'string',
          description: 'User-facing answer. Omit or use an empty string when there is nothing to say.',
        },
        question,
        operations: {
          type: 'array',
          description: 'Canvas operations. Use [] for answer-only or no-op turns.',
          items: operation,
        },
      },
      required: ['operations'],
    }
  }

  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      reply: {
        type: 'string',
        description: 'User-facing answer. Use an empty string if there is nothing to say.',
      },
      question: strictSchema(question, true),
      operations: {
        type: 'array',
        description: 'Canvas operations. Use [] for answer-only or no-op turns.',
        items: strictSchema(operation),
      },
    },
    required: ['reply', 'question', 'operations'],
  }
}

/** Project a provider's structured envelope into the common Conversation turn shape. */
export function projectCanvasTurn(
  structured: unknown,
  options: ProjectTurnOptions,
): LlmTurn {
  const obj = recordOf(structured) ?? {}
  const structuredReply = typeof obj.reply === 'string' ? obj.reply : ''
  const text = options.visibleText?.trim() || structuredReply
  const operations = Array.isArray(obj.operations) ? obj.operations : []
  const question = normalizeLlmQuestion(obj.question)
  const toolCalls: LlmToolCall[] = []

  operations.forEach((operation, index) => {
    const value = recordOf(stripNulls(operation))
    if (!value || typeof value.op !== 'string') return
    const { op: name, ...args } = value
    toolCalls.push({ id: `${options.callIdPrefix}-${index}`, name, args })
  })

  return question ? { text, toolCalls, question } : { text, toolCalls }
}

function mergedOperationSchema(tools: ToolDef[]): JsonSchema {
  const properties: Record<string, unknown> = {
    op: {
      type: 'string',
      enum: tools.map((tool) => tool.name),
      description: 'Canvas operation type.',
    },
  }
  for (const tool of tools) {
    const toolProperties = recordOf(tool.parameters.properties) ?? {}
    for (const [name, schema] of Object.entries(toolProperties)) {
      if (!(name in properties)) properties[name] = schema
    }
  }
  return {
    type: 'object',
    properties,
    required: ['op'],
  }
}

/** Convert ordinary JSON Schema into the closed/all-required subset Codex accepts. */
function strictSchema(schema: JsonSchema, nullable = false): JsonSchema {
  const out: JsonSchema = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' || key === 'required' || key === 'items' || key === 'additionalProperties') continue
    out[key] = value
  }

  if (schema.type === 'object') {
    const properties = recordOf(schema.properties) ?? {}
    const originallyRequired = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((value): value is string => typeof value === 'string')
        : [],
    )
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([name, value]) => [
        name,
        strictSchema(recordOf(value) ?? {}, !originallyRequired.has(name)),
      ]),
    )
    out.required = Object.keys(properties)
    out.additionalProperties = false
  } else if (schema.type === 'array') {
    out.items = strictSchema(recordOf(schema.items) ?? {})
  }

  return nullable ? withNull(out) : out
}

function withNull(schema: JsonSchema): JsonSchema {
  const type = schema.type
  if (typeof type === 'string') schema.type = [type, 'null']
  else if (Array.isArray(type) && !type.includes('null')) schema.type = [...type, 'null']
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) schema.enum = [...schema.enum, null]
  return schema
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls).filter((item) => item !== null)
  const record = recordOf(value)
  if (!record) return value
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, stripNulls(item)]),
  )
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
