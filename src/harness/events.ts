import type { AgentActivityEvent, AgentQuestion } from '../agent'
import type { HarnessEvent } from './types'

export interface HarnessCallbacks {
  onText?(text: string, source?: 'model'): void
  onActivity?(event: AgentActivityEvent, source?: 'model'): void
  onQuestion?(question: AgentQuestion, source?: 'model'): void
  onDebug?(text: string): void
}

/** Native events are routed once at the harness boundary, independently of canvas policy. */
export function routeHarnessEvent(event: HarnessEvent, callbacks: HarnessCallbacks): void {
  if (event.kind === 'activity') callbacks.onActivity?.(event.activity, 'model')
  else if (event.kind === 'question') callbacks.onQuestion?.(event.question, 'model')
  else if (event.kind === 'text') callbacks.onText?.(event.text, 'model')
}
