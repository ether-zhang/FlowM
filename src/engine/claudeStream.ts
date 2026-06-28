/**
 * Pure interpreter for Claude Code's `--output-format stream-json` lines. Each stdout line
 * is one JSON event; this maps it to chat-level items — assistant prose, or a short system
 * note for tool activity / the final result. The (possibly huge) tool_result content is
 * never surfaced verbatim. No DOM, no Tauri — unit-testable in isolation.
 */
export type StreamItem = { kind: 'text'; text: string } | { kind: 'system'; text: string }

/* eslint-disable @typescript-eslint/no-explicit-any */
export function interpretClaudeLine(line: string): StreamItem[] {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return [] // non-JSON noise (shouldn't happen on stdout, but be tolerant)
  }
  if (!ev || typeof ev !== 'object') return []

  switch (ev.type) {
    case 'system':
      return ev.subtype === 'init' ? [sys(`▶ Claude Code · ${ev.model ?? ''} · ${ev.cwd ?? ''}`)] : []

    case 'assistant': {
      const out: StreamItem[] = []
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text) out.push({ kind: 'text', text: c.text })
        // StructuredOutput is FlowM's own --json-schema plumbing (draw mode), not a real
        // action — surfacing "🔧 StructuredOutput" would just be noise; the drawn result is
        // the feedback. Other tool_use (Read/Grep/…) shows so the user sees Claude work.
        else if (c.type === 'tool_use' && c.name !== 'StructuredOutput') out.push(sys(`🔧 ${c.name}${toolHint(c.name, c.input)}`))
        // 'thinking' blocks are dropped
      }
      return out
    }

    case 'user': {
      const r = (ev.message?.content ?? []).find((c: any) => c?.type === 'tool_result')
      return r ? [sys(r.is_error ? '  ↳ 工具出错' : '  ↳ 工具完成')] : []
    }

    case 'result': {
      const cost = typeof ev.total_cost_usd === 'number' ? `$${ev.total_cost_usd.toFixed(3)}` : '?'
      return [sys(`✓ 完成 · ${ev.num_turns ?? '?'} 轮 · ${cost}`)]
    }

    default:
      return []
  }
}

const sys = (text: string): StreamItem => ({ kind: 'system', text })

/**
 * Pull the validated `--json-schema` payload out of a stream line: the final `result` event
 * carries it parsed in `structured_output` (draw mode reads it to draw the diagram). Returns
 * null for every other line (and when no schema was used, so it's harmless to call always).
 */
export function extractStructured(line: string): unknown | null {
  try {
    const ev = JSON.parse(line)
    if (ev && ev.type === 'result' && ev.structured_output != null) return ev.structured_output
  } catch {
    // non-JSON noise
  }
  return null
}

/** A short, safe hint for a tool call (the command / file), never the full payload. */
function toolHint(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  if (name === 'Bash' && input.command) return `: ${truncate(String(input.command), 80)}`
  if (typeof input.file_path === 'string') return `: ${input.file_path}`
  return ''
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
