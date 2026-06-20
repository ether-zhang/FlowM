import OpenAI from 'openai'
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'
import type { LlmAdapter, RunTurnParams, TurnCallbacks } from './adapter'
import type { LlmMessage, LlmTurn } from './types'

/** Poe's OpenAI-compatible endpoint (direct). */
export const POE_BASE_URL = 'https://api.poe.com/v1'
/** Default Poe bot/model name. If this 404s, try the capitalized form (e.g. "Claude-Opus-4.8"). */
export const MODEL = 'claude-opus-4.8'

/**
 * Poe blocks browser CORS, so in dev we route through the Vite proxy (see
 * vite.config.ts) at a same-origin path. In a non-dev browser build there is no
 * proxy — the direct URL will CORS-fail. The Tauri build avoids this entirely by
 * making the HTTP call from Rust (see src/llm/tauri.ts).
 */
function resolveBaseUrl(): string {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    return `${window.location.origin}/poe/v1`
  }
  return POE_BASE_URL
}

function toOpenAiMessages(system: string, messages: LlmMessage[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })),
            }
          : {}),
      })
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
    }
  }
  return out
}

/**
 * Build the OpenAI-format chat-completions request body. Shared by the browser
 * adapter (passes it to the OpenAI SDK) and the Tauri adapter (invokes it to the
 * Rust proxy) so both runtimes produce byte-identical requests.
 */
export function buildChatBody(params: RunTurnParams): ChatCompletionCreateParamsNonStreaming {
  const tools: ChatCompletionTool[] = params.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  return {
    model: MODEL,
    messages: toOpenAiMessages(params.system, params.messages),
    tools,
    tool_choice: 'auto',
  }
}

/** The slice of an OpenAI chat-completion response that we read. */
export interface ChatResponseLike {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
}

/**
 * Map an OpenAI-format chat-completion response into a provider-neutral turn.
 * Works for both the SDK's typed response and the raw JSON returned by the Rust
 * proxy (same wire shape).
 */
export function parseTurn(res: ChatResponseLike, cb: TurnCallbacks): LlmTurn {
  const msg = res.choices?.[0]?.message
  const text = msg?.content ?? ''
  if (text) cb.onText(text)

  const toolCalls = (msg?.tool_calls ?? []).flatMap((tc) => {
    if (tc.type && tc.type !== 'function') return []
    const fn = tc.function
    if (!fn?.name) return []
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(fn.arguments || '{}')
    } catch {
      // leave args empty; the op validator will reject and report back to the model
    }
    return [{ id: tc.id, name: fn.name, args }]
  })

  return { text, toolCalls }
}

/**
 * Poe adapter via the OpenAI-compatible Chat Completions API.
 *
 * Non-streaming on purpose: Poe's OpenAI-compatible streaming has reported
 * silent-stop issues when combined with tool calls. Non-streaming is reliable
 * for the MVP; switching to `client.chat.completions.stream(...)` is a localized
 * change here if/when desired.
 *
 * NOTE on the key: in browser/PWA dev there is no backend, so the user-supplied
 * key is used from the renderer with `dangerouslyAllowBrowser`. Fine for personal/
 * MVP use; the Tauri build moves the call behind a Rust command (see tauri.ts).
 */
export class PoeAdapter implements LlmAdapter {
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: resolveBaseUrl(), dangerouslyAllowBrowser: true })
  }

  async runTurn(params: RunTurnParams, cb: TurnCallbacks): Promise<LlmTurn> {
    const res = await this.client.chat.completions.create(buildChatBody(params))
    return parseTurn(res as ChatResponseLike, cb)
  }
}
