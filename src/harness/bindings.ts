import { HarnessSession } from './session'
import { HarnessTurn } from './turn'
import type { HarnessBinding, HarnessExecution } from './types'

export interface HarnessScope {
  projectRoot: string
  flowSessionId: string
  getExecution(): HarnessExecution
}

function binding(scope: HarnessScope, role: HarnessBinding['role'], system: string): HarnessBinding {
  const run = scope.getExecution()
  if (run.projectRoot !== scope.projectRoot || run.flowSessionId !== scope.flowSessionId || run.role !== role) {
    throw new Error('Execution belongs to another conversation or role')
  }
  return { ...run, system }
}

/** Native conversations own history and choose the execution segment. */
export function createCanvasTurn(scope: HarnessScope): HarnessTurn {
  return new HarnessTurn((system) => binding(scope, 'canvas', system))
}
export function createProjectSession(scope: HarnessScope): HarnessSession {
  return new HarnessSession(() => binding(scope, 'project', ''))
}
