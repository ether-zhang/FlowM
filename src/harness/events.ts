import type { AgentActivityEvent, AgentQuestion } from '../agent'
import type { HarnessEvent } from './types'

export interface HarnessCallbacks {
  onText?(text: string): void
  onActivity?(event: AgentActivityEvent): void
  onQuestion?(question: AgentQuestion): void
  onDebug?(text: string): void
}

/** Native events are routed once at the harness boundary, independently of canvas policy. */
export function routeHarnessEvent(event: HarnessEvent, callbacks: HarnessCallbacks): void {
  if (event.kind === 'activity') callbacks.onActivity?.(event.activity)
  else if (event.kind === 'question') callbacks.onQuestion?.(event.question)
  else if (event.kind === 'text') callbacks.onText?.(event.text)
}
