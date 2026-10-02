import { HarnessSession } from './session'
import { harnessClient } from './client'
import { HarnessTurn } from './turn'
import type { HarnessBinding, HarnessConnection } from './types'

export interface HistoryEntry { role: string; text: string; question?: unknown }
export interface HarnessScope {
  projectRoot: string
  flowSessionId: string
  threadId?: string
  history?: readonly HistoryEntry[]
  onOpened?(id: string): Promise<void>
}

export function harnessBindingKey(connection: HarnessConnection, role: HarnessBinding['role']): string {
  return JSON.stringify([connection.profileId, connection.credentialVersion, role, connection.model])
}

export function continuationContext(messages: readonly HistoryEntry[]): string {
  return messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && !message.question && message.text.trim())
    .map((message) => `${message.role}: ${message.text}`).join('\n\n').slice(-32_000)
}

/** Factories capture one validated model/credential selection for the whole private session. */
export function createCanvasTurn(connection: HarnessConnection, scope: HarnessScope): HarnessTurn {
  const { history, onOpened, ...binding } = scope
  const context = scope.threadId ? '' : continuationContext(history ?? [])
  return new HarnessTurn({ ...binding, ...connection, role: 'canvas' },
    (request) => new HarnessSession(request, harnessClient, onOpened, context))
}

export function createProjectSession(connection: HarnessConnection, scope: HarnessScope): HarnessSession {
  const { history, onOpened, ...binding } = scope
  return new HarnessSession({ ...binding, ...connection, role: 'project', system: '' }, harnessClient,
    onOpened, scope.threadId ? '' : continuationContext(history ?? []))
}
