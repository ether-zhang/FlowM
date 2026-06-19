import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'
import type { LlmAdapter, RunTurnParams, TurnCallbacks } from './adapter'
import type { LlmMessage, LlmTurn } from './types'

/** Poe's OpenAI-compatible endpoint. */
export const POE_BASE_URL = 'https://api.poe.com/v1'
/** Default Poe bot/model name. If this 404s, try the capitalized form (e.g. "Claude-Opus-4.8"). */
export const MODEL = 'claude-opus-4.8'

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
 * Poe adapter via the OpenAI-compatible Chat Completions API.
 *
 * Non-streaming on purpose: Poe's OpenAI-compatible streaming has reported
 * silent-stop issues when combined with tool calls. Non-streaming is reliable
 * for the MVP; switching to `client.chat.completions.stream(...)` is a localized
 * change here if/when desired.
 *
 * NOTE on the key: in browser/PWA dev there is no backend, so the user-supplied
 * key is used from the renderer with `dangerouslyAllowBrowser`. Fine for personal/
 * MVP use; under Tauri move the call behind a Rust command (see plan, step 8).
 */
export class PoeAdapter implements LlmAdapter {
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: POE_BASE_URL, dangerouslyAllowBrowser: true })
  }

  async runTurn(params: RunTurnParams, cb: TurnCallbacks): Promise<LlmTurn> {
    const tools: ChatCompletionTool[] = params.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))

    const res = await this.client.chat.completions.create({
      model: MODEL,
      messages: toOpenAiMessages(params.system, params.messages),
      tools,
      tool_choice: 'auto',
    })

    const msg = res.choices[0]?.message
    const text = msg?.content ?? ''
    if (text) cb.onText(text)

    const toolCalls = (msg?.tool_calls ?? []).flatMap((tc) => {
      if (tc.type !== 'function') return []
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}')
      } catch {
        // leave args empty; the op validator will reject and report back to the model
      }
      return [{ id: tc.id, name: tc.function.name, args }]
    })

    return { text, toolCalls }
  }
}
