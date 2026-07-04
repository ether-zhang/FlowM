/**
 * Small interpreter for `codex exec --json` JSONL. The CLI event schema is intentionally treated
 * loosely here: FlowM only needs user-facing progress notes, assistant text when present, and the
 * thread id used by `codex exec resume`.
 */
export type StreamItem = { kind: 'text'; text: string } | { kind: 'system'; text: string }

/* eslint-disable @typescript-eslint/no-explicit-any */
export function interpretCodexLine(line: string): StreamItem[] {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return []
  }
  if (!ev || typeof ev !== 'object') return []

  if (ev.type === 'thread.started') return [sys(`▶ Codex · ${ev.thread_id ?? ''}`)]
  if (ev.type === 'turn.started') return [sys('Codex 开始处理')]
  if (ev.type === 'turn.failed') return [sys(`Codex 出错: ${errorText(ev.error)}`)]
  if (ev.type === 'error' && ev.message) return [sys(`Codex: ${ev.message}`)]

  if (ev.type === 'item.completed' && ev.item) {
    const item = ev.item
    if (item.type === 'error') return [sys(`Codex: ${item.message ?? 'error'}`)]
    if (item.type === 'command_execution' || item.type === 'tool_call') {
      return [sys(`🔧 ${item.name ?? item.command ?? item.type}`)]
    }
    const text = textFrom(item)
    return text ? [{ kind: 'text', text }] : []
  }

  if (ev.type === 'agent_message' || ev.type === 'assistant_message') {
    const text = textFrom(ev)
    return text ? [{ kind: 'text', text }] : []
  }

  if (ev.type === 'turn.completed') return [sys('✓ Codex 完成')]
  return []
}

export function extractCodexThreadId(line: string): string | null {
  try {
    const ev = JSON.parse(line)
    if (ev && ev.type === 'thread.started' && typeof ev.thread_id === 'string') return ev.thread_id
    if (ev && typeof ev.session_id === 'string') return ev.session_id
    if (ev && typeof ev.sessionId === 'string') return ev.sessionId
  } catch {
    // non-JSON noise
  }
  return null
}

export function isIgnorableCodexStderr(line: string): boolean {
  const s = line.trim()
  return (
    s === 'Reading prompt from stdin...' ||
    (s.includes('codex_models_manager::manager') && s.includes('failed to refresh available models')) ||
    (s.includes('rmcp::transport::worker') &&
      s.includes('AuthRequired') &&
      s.includes('api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/'))
  )
}

export function createCodexStderrFilter(): (line: string) => string | null {
  let suppressToolRouterDump = false
  return (line: string) => {
    const s = line.trim()
    if (isIgnorableCodexStderr(line)) return null

    if (suppressToolRouterDump) {
      if (/^\d{4}-\d{2}-\d{2}T\S+Z\s+ERROR\s+codex_/.test(s)) {
        suppressToolRouterDump = false
        return isToolRouterDumpStart(s) ? null : line
      }
      if (s === '') suppressToolRouterDump = false
      return null
    }

    if (isToolRouterDumpStart(s)) {
      suppressToolRouterDump = true
      return null
    }

    return line
  }
}

function isToolRouterDumpStart(line: string): boolean {
  return line.includes('ERROR codex_core::tools::router: error=Exit code:')
}

const sys = (text: string): StreamItem => ({ kind: 'system', text })

function errorText(error: unknown): string {
  if (!error) return 'unknown'
  if (typeof error === 'string') return error
  if (typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message
  return JSON.stringify(error)
}

function textFrom(obj: any): string {
  if (!obj || typeof obj !== 'object') return ''
  if (typeof obj.text === 'string') return obj.text
  if (typeof obj.message === 'string') return obj.message
  if (typeof obj.content === 'string') return obj.content
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((c: any) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('')
  }
  if (obj.message && typeof obj.message === 'object') return textFrom(obj.message)
  return ''
}
