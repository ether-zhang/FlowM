import Anthropic from '@anthropic-ai/sdk'
import type { LlmAdapter, StreamTurnParams, TurnCallbacks } from './adapter'

export const MODEL = 'claude-opus-4-8'

/**
 * Direct Claude API adapter.
 *
 * NOTE on the key: in browser/PWA dev there is no backend, so the user-supplied
 * key is used from the renderer with `dangerouslyAllowBrowser`. This is fine for
 * personal/MVP use but the key is exposed to page scripts — under Tauri the call
 * should be moved behind a Rust command (see plan, step 8). The LlmAdapter
 * boundary keeps the rest of the app unchanged when that swap happens.
 */
export class ClaudeAdapter implements LlmAdapter {
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  }

  async streamTurn(params: StreamTurnParams, cb: TurnCallbacks): Promise<Anthropic.Message> {
    const stream = this.client.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: params.system,
      tools: params.tools,
      messages: params.messages,
    })
    stream.on('text', (delta) => cb.onText(delta))
    return stream.finalMessage()
  }
}
