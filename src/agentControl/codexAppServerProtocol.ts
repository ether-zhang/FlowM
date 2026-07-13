import type { AgentActivityEvent, AgentQuestion, AgentQuestionAnswer, AgentToolStatus } from './types'

export type JsonRpcId = string | number

export interface JsonRpcMessage {
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export interface CodexPendingQuestion {
  question: AgentQuestion
  result(answer: AgentQuestionAnswer): unknown
}

interface RequestUserInputOption {
  label?: unknown
  description?: unknown
}

interface RequestUserInputQuestion {
  id?: unknown
  header?: unknown
  question?: unknown
  isOther?: unknown
  isSecret?: unknown
  options?: unknown
}

export function parseCodexQuestion(requestId: string, params: unknown): AgentQuestion | null {
  if (!params || typeof params !== 'object') return null
  const raw = params as { questions?: unknown; autoResolutionMs?: unknown }
  if (!Array.isArray(raw.questions)) return null
  const items = raw.questions.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return []
    const question = value as RequestUserInputQuestion
    if (typeof question.question !== 'string' || !question.question.trim()) return []
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return []
          const rawOption = option as RequestUserInputOption
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
      id: typeof question.id === 'string' && question.id ? question.id : `question-${index + 1}`,
      prompt: question.question.trim(),
      ...(typeof question.header === 'string' && question.header.trim()
        ? { header: question.header.trim() }
        : {}),
      ...(options?.length ? { options } : {}),
      allowOther: question.isOther === true || !options?.length,
      secret: question.isSecret === true,
    }]
  })
  if (items.length === 0) return null
  return {
    requestId,
    items,
    ...(typeof raw.autoResolutionMs === 'number' && Number.isFinite(raw.autoResolutionMs)
      ? { autoResolutionMs: raw.autoResolutionMs }
      : {}),
  }
}

export function codexQuestionResult(answer: AgentQuestionAnswer): { answers: Record<string, { answers: string[] }> } {
  return {
    answers: Object.fromEntries(
      Object.entries(answer.answers).map(([id, values]) => [id, { answers: values }]),
    ),
  }
}

const approvalLabels = {
  accept: 'Allow',
  acceptForSession: 'Always allow',
  decline: 'Deny',
  cancel: 'Deny and stop',
} as const

type SimpleApprovalDecision = keyof typeof approvalLabels

export function parseCodexServerRequest(
  requestId: string,
  method: string,
  params: unknown,
): CodexPendingQuestion | null {
  if (method === 'item/tool/requestUserInput') {
    const question = parseCodexQuestion(requestId, params)
    return question ? { question, result: codexQuestionResult } : null
  }
  if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
    return null
  }
  const value = recordOf(params)
  if (!value) return null
  const commandApproval = method === 'item/commandExecution/requestApproval'
  const available = commandApproval && Array.isArray(value.availableDecisions)
    ? value.availableDecisions.filter(isSimpleApprovalDecision)
    : ['accept', 'acceptForSession', 'decline'] satisfies SimpleApprovalDecision[]
  const decisions: SimpleApprovalDecision[] = available.length ? available : ['accept', 'decline']
  const prompt = commandApproval
    ? stringValue(value.reason) || 'Allow this command?'
    : stringValue(value.reason) || 'Allow these file changes?'
  const detail = commandApproval
    ? commandText(value.command)
    : fileChangeApprovalDetail(value)
  const labelsToDecision = new Map<string, SimpleApprovalDecision>(
    decisions.map((decision) => [approvalLabels[decision], decision]),
  )
  const question: AgentQuestion = {
    requestId,
    items: [{
      id: 'decision',
      header: commandApproval ? 'Command permission' : 'File permission',
      prompt: detail ? `${prompt}\n\n${detail}` : prompt,
      options: decisions.map((decision) => ({ label: approvalLabels[decision] })),
      allowOther: false,
    }],
  }
  return {
    question,
    result(answer) {
      const label = answer.answers.decision?.[0]
      return { decision: labelsToDecision.get(label) ?? 'decline' }
    },
  }
}

export function codexActivityForItem(item: unknown): AgentActivityEvent | null {
  const value = recordOf(item)
  const id = stringValue(value?.id)
  const type = stringValue(value?.type)
  if (!value || !id || !type) return null
  const status = toolStatus(value.status)
  if (type === 'commandExecution') {
    return {
      type: 'tool', id, name: 'Command', toolKind: 'command', status,
      detail: commandText(value.command),
      output: trimOutput(stringValue(value.aggregatedOutput)),
    }
  }
  if (type === 'fileChange') {
    return {
      type: 'tool', id, name: 'Edit files', status,
      detail: changedPaths(value.changes),
    }
  }
  if (type === 'mcpToolCall') {
    const server = stringValue(value.server)
    const tool = stringValue(value.tool) || 'MCP tool'
    return {
      type: 'tool', id, name: tool, status,
      detail: server ? `${server} / ${tool}` : undefined,
      output: trimOutput(errorText(value.error)),
    }
  }
  if (type === 'dynamicToolCall') {
    return { type: 'tool', id, name: stringValue(value.tool) || 'Tool', status }
  }
  if (type === 'webSearch') {
    return { type: 'tool', id, name: 'Web search', status: 'completed', detail: stringValue(value.query) }
  }
  if (type === 'imageView') {
    return { type: 'tool', id, name: 'View image', status: 'completed', detail: stringValue(value.path) }
  }
  if (type === 'collabAgentToolCall') {
    return { type: 'tool', id, name: stringValue(value.tool) || 'Agent task', status }
  }
  return null
}

/** Public reasoning summary attached to a completed reasoning item. */
export function codexReasoningText(item: unknown): string | null {
  const value = recordOf(item)
  if (value?.type !== 'reasoning' || !Array.isArray(value.summary)) return null
  const summary = value.summary
    .filter((part): part is string => typeof part === 'string' && !!part.trim())
    .join('\n\n')
    .trim()
  return summary || null
}

export function codexCommentaryEvent(
  itemId: string,
  phase: string | undefined,
  delta: string,
): AgentActivityEvent | null {
  return phase === 'commentary'
    ? { type: 'commentary_delta', id: itemId, delta }
    : null
}

/** Extract the terminal assistant message from a turn completion payload.
 * A turn may contain structured commentary before tool calls and a separate final answer. */
export function codexCompletedTurnText(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null
  const turn = (params as { turn?: unknown }).turn
  if (!turn || typeof turn !== 'object') return null
  const items = (turn as { items?: unknown }).items
  if (!Array.isArray(items)) return null

  const messages = items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as { type?: unknown; text?: unknown; phase?: unknown }
    if (record.type !== 'agentMessage' || typeof record.text !== 'string') return []
    return [{ text: record.text, phase: record.phase }]
  })
  const final = messages.findLast((message) => message.phase === 'final_answer')
  return final?.text ?? messages.at(-1)?.text ?? null
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function commandText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const command = value.filter((part): part is string => typeof part === 'string').join(' ').trim()
    return command || undefined
  }
  return stringValue(value)
}

function isSimpleApprovalDecision(value: unknown): value is SimpleApprovalDecision {
  return typeof value === 'string' && value in approvalLabels
}

function fileChangeApprovalDetail(value: Record<string, unknown>): string | undefined {
  return stringValue(value.grantRoot) ? `Write access: ${stringValue(value.grantRoot)}` : undefined
}

function changedPaths(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const paths = value.flatMap((change) => {
    const path = stringValue(recordOf(change)?.path)
    return path ? [path] : []
  })
  return paths.length ? paths.join('\n') : undefined
}

function toolStatus(value: unknown): AgentToolStatus {
  if (value === 'completed') return 'completed'
  if (value === 'failed') return 'failed'
  if (value === 'declined') return 'declined'
  return 'running'
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const record = recordOf(value)
  return stringValue(record?.message) || stringValue(record?.error)
}

function trimOutput(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length > 8_000 ? `${value.slice(0, 8_000)}\n…` : value
}
