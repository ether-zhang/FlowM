import { invoke } from '@tauri-apps/api/core'
import type { AgentModel } from '../agent'
import { parseClaudeModels } from './claudeControlProtocol'
import { parseCodexModelPage } from './codexAppServerProtocol'

/** Metadata-only native probes; independent of workspace conversations and LLM turns. */
export async function listAgentModels(provider: 'claude' | 'codex', bin: string, cwd: string): Promise<AgentModel[]> {
  const response = await invoke<unknown>('list_agent_models', {
    provider, bin: bin.trim() || null, cwd: cwd.trim() || null,
  })
  const models = provider === 'claude' ? parseClaudeModels(response) : parseCodexModelPage(response).models
  return [...new Map(models.map((model) => [model.id, model])).values()]
}
