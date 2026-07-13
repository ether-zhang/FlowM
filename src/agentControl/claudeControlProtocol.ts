import type { AgentActivityEvent, AgentQuestion, AgentQuestionAnswer } from './types'

interface ClaudeQuestionOption {
  label?: unknown
  description?: unknown
}

interface ClaudeQuestion {
  question?: unknown
  header?: unknown
  options?: unknown
  multiSelect?: unknown
}

export interface ClaudePendingQuestion {
  controlRequestId: string
  originalInput: Record<string, unknown>
  question: AgentQuestion
  promptsById: Record<string, string>
}

export interface ClaudePendingPermission {
  controlRequestId: string
  originalInput: Record<string, unknown>
  question: AgentQuestion
}

export function parseClaudeQuestion(
  requestId: string,
  controlRequestId: string,
  input: unknown,
): ClaudePendingQuestion | null {
  if (!input || typeof input !== 'object') return null
  const originalInput = input as Record<string, unknown>
  if (!Array.isArray(originalInput.questions)) return null
  const promptsById: Record<string, string> = {}
  const items = originalInput.questions.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return []
    const raw = value as ClaudeQuestion
    if (typeof raw.question !== 'string' || !raw.question.trim()) return []
    const id = `question-${index + 1}`
    const prompt = raw.question.trim()
    promptsById[id] = prompt
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return []
          const rawOption = option as ClaudeQuestionOption
          if (typeof rawOption.label !== 'string' || !rawOption.label.trim()) return []
          return [{
            label: rawOption.label.trim(),
            ...(typeof rawOption.description === 'string' && rawOption.description.trim()
              ? { description: rawOption.description.trim() }
              : {}),
          }]
        })
      : undefined
    return [{
      id,
      prompt,
      ...(typeof raw.header === 'string' && raw.header.trim() ? { header: raw.header.trim() } : {}),
      ...(options?.length ? { options } : {}),
      multiSelect: raw.multiSelect === true,
      allowOther: true,
    }]
  })
  if (items.length === 0) return null
  return {
    controlRequestId,
    originalInput,
    promptsById,
    question: { requestId, items },
  }
}

export function claudeQuestionUpdatedInput(
  pending: ClaudePendingQuestion,
  answer: AgentQuestionAnswer,
): Record<string, unknown> {
  const answers: Record<string, string | string[]> = {}
  for (const [id, values] of Object.entries(answer.answers)) {
    const prompt = pending.promptsById[id]
    if (!prompt || values.length === 0) continue
    answers[prompt] = values.length === 1 ? values[0] : values
  }
  return { ...pending.originalInput, answers }
}

const safeClaudeTools = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'StructuredOutput'])

export function shouldAskClaudeToolPermission(toolName: string): boolean {
  return !safeClaudeTools.has(toolName)
}

export function parseClaudePermission(
  requestId: string,
  controlRequestId: string,
  toolName: string,
  input: Record<string, unknown>,
): ClaudePendingPermission {
  const detail = claudeToolDetail(toolName, input)
  return {
    controlRequestId,
    originalInput: input,
    question: {
      requestId,
      items: [{
        id: 'decision',
        header: 'Tool permission',
        prompt: detail ? `Allow ${toolName}?\n\n${detail}` : `Allow ${toolName}?`,
        options: [{ label: 'Allow' }, { label: 'Deny' }],
        allowOther: false,
      }],
    },
  }
}

export function claudePermissionResponse(
  pending: ClaudePendingPermission,
  answer: AgentQuestionAnswer,
): Record<string, unknown> {
  return answer.answers.decision?.[0] === 'Allow'
    ? { behavior: 'allow', updatedInput: pending.originalInput }
    : { behavior: 'deny', message: 'The user denied this tool call.' }
}

export type ClaudePartialEvent =
  | { type: 'message_start' }
  | {
      type: 'block_start'
      index: number
      blockType: 'text' | 'thinking' | 'tool'
      tool?: Extract<AgentActivityEvent, { type: 'tool' }>
    }
  | { type: 'block_delta'; index: number; blockType: 'text' | 'thinking'; delta: string }
  | { type: 'message_delta'; stopReason: string }

export interface ClaudeAssistantContent {
  blocks: Record<string, unknown>[]
  stopReason?: string
}

export type ClaudeAssistantTextRole = 'commentary' | 'final'

export function parseClaudeAssistantContent(value: unknown): ClaudeAssistantContent | null {
  const message = recordOf(value)
  if (!message || !Array.isArray(message.content)) return null
  const blocks = message.content.flatMap((block) => {
    const record = recordOf(block)
    return record ? [record] : []
  })
  return {
    blocks,
    ...(typeof message.stop_reason === 'string' ? { stopReason: message.stop_reason } : {}),
  }
}

export function claudeAssistantTextRole(stopReason: unknown): ClaudeAssistantTextRole | null {
  if (stopReason === 'tool_use') return 'commentary'
  if (stopReason === 'end_turn') return 'final'
  return null
}

export function parseClaudePartialEvent(message: Record<string, unknown>): ClaudePartialEvent | null {
  if (message.type !== 'stream_event') return null
  const event = recordOf(message.event)
  if (!event) return null
  if (event.type === 'message_start') return { type: 'message_start' }
  if (event.type === 'message_delta') {
    const stopReason = stringValue(recordOf(event.delta)?.stop_reason)
    return stopReason ? { type: 'message_delta', stopReason } : null
  }
  const index = typeof event.index === 'number' ? event.index : 0
  if (event.type === 'content_block_start') {
    const block = recordOf(event.content_block)
    if (block?.type === 'text') return { type: 'block_start', index, blockType: 'text' }
    if (block?.type === 'thinking') return { type: 'block_start', index, blockType: 'thinking' }
    if (block?.type === 'tool_use') return {
      type: 'block_start',
      index,
      blockType: 'tool',
      tool: claudeToolActivity(block) ?? undefined,
    }
    return null
  }
  if (event.type !== 'content_block_delta') return null
  const delta = recordOf(event.delta)
  if (!delta) return null
  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
    return { type: 'block_delta', index, blockType: 'text', delta: delta.text }
  }
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return { type: 'block_delta', index, blockType: 'thinking', delta: delta.thinking }
  }
  return null
}

export function claudeToolActivity(
  block: unknown,
): Extract<AgentActivityEvent, { type: 'tool' }> | null {
  const value = recordOf(block)
  if (value?.type !== 'tool_use') return null
  const id = stringValue(value.id)
  const name = stringValue(value.name)
  if (!id || !name) return null
  return {
    type: 'tool', id, name, status: 'running',
    ...(name === 'Bash' ? { toolKind: 'command' as const } : {}),
    detail: claudeToolDetail(name, recordOf(value.input) ?? {}),
  }
}

export function claudeToolResultActivity(block: unknown): AgentActivityEvent | null {
  const value = recordOf(block)
  if (value?.type !== 'tool_result') return null
  const id = stringValue(value.tool_use_id)
  if (!id) return null
  const failed = value.is_error === true
  return {
    type: 'tool_status', id, status: failed ? 'failed' : 'completed',
    output: shortToolResult(value.content),
  }
}

function claudeToolDetail(toolName: string, input: Record<string, unknown>): string | undefined {
  const candidates = toolName === 'Bash'
    ? [input.command]
    : [input.file_path, input.path, input.pattern, input.query, input.url, input.command]
  const detail = candidates.find((value) => typeof value === 'string' && value.trim())
  if (typeof detail !== 'string') return undefined
  return detail.length > 500 ? `${detail.slice(0, 500)}…` : detail
}

function shortToolResult(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value
  if (!Array.isArray(value)) return undefined
  const text = value.flatMap((item) => {
    const record = recordOf(item)
    return typeof record?.text === 'string' ? [record.text] : []
  }).join('\n')
  return text ? (text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text) : undefined
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
