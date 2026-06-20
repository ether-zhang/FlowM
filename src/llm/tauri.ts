import { invoke } from '@tauri-apps/api/core'
import type { LlmAdapter, RunTurnParams, TurnCallbacks } from './adapter'
import type { LlmTurn } from './types'
import { buildChatBody, parseTurn, type ChatResponseLike } from './poe'

/**
 * Desktop adapter: builds the same OpenAI-format request as the browser adapter
 * but sends it through the Rust `poe_chat` command. The API key lives in the Rust
 * backend (app config dir) and never enters the renderer; native HTTP also has no
 * browser CORS restriction.
 */
export class TauriAdapter implements LlmAdapter {
  async runTurn(params: RunTurnParams, cb: TurnCallbacks): Promise<LlmTurn> {
    const body = buildChatBody(params)
    const res = await invoke<ChatResponseLike>('poe_chat', { body })
    return parseTurn(res, cb)
  }
}

/** Key management backed by the Rust commands (key stored outside the renderer). */
export const tauriKey = {
  has: () => invoke<boolean>('has_api_key'),
  set: (key: string) => invoke<void>('set_api_key', { key }),
  clear: () => invoke<void>('clear_api_key'),
}
