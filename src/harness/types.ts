import type { AgentActivityEvent, AgentQuestion } from '../agent'

export const HARNESS_PROTOCOL = 'flowm.harness/4'

export interface HarnessModel {
  id: string
  label: string
}

export interface HarnessModelCatalog {
  profileId: string
  credentialVersion: number
  source: 'openai-account' | 'openai-api' | 'gateway'
  models: HarnessModel[]
  defaultModel: string | null
}

export interface HarnessProfile {
  id: string
  name: string
  kind: 'openai' | 'gateway'
  baseUrl: string
  model: string
  authKind: 'none' | 'bearer' | 'chatgpt'
  credentialVersion: number
  account: string | null
  subject: string | null
  clientId: string | null
  signedIn?: boolean
}

export interface HarnessBinding {
  threadId?: string
  projectRoot: string
  flowSessionId: string
  profileId: string
  credentialVersion: number
  role: 'canvas' | 'project'
  model: string
  system: string
}

/** A model selection validated against the current connection's live catalog. */
export interface HarnessConnection {
  profileId: string
  credentialVersion: number
  model: string
}

export interface TurnReceipt {
  requestId: string
  threadId: string
  status: 'accepted' | 'running' | 'completed' | 'failed' | 'interrupted' | 'uncertain' | 'not-received'
  nativeTurnId?: string | null
  text?: string | null
  error?: string | null
}

export type HarnessEvent =
  | { kind: 'text'; text: string }
  | { kind: 'activity'; activity: AgentActivityEvent }
  | { kind: 'question'; question: AgentQuestion }

export interface HarnessNotification {
  method: string
  params: Record<string, unknown>
}

export interface HarnessProcessEvent {
  kind: 'stdout' | 'stderr' | 'exit'
  line?: string
  code?: number | null
}

export interface HarnessTransport {
  write(message: unknown): Promise<void>
  stop(): Promise<void>
}
export type HarnessTransportFactory = (onEvent: (event: HarnessProcessEvent) => void) => Promise<HarnessTransport>
