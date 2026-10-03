import { describe, expect, it } from 'vitest'
import { createProjectSession } from './bindings'
import type { HarnessExecution } from '../harness'

const execution: HarnessExecution = { projectRoot: '/project', flowSessionId: 's', userTurnId: 'u', role: 'project', profileId: 'p', model: 'm', credentialVersion: 1 }
describe('FlowM session migration boundaries', () => {
  it.each(['flowSessionId', 'projectRoot', 'role'] as const)('rejects an execution belonging to another %s before opening a thread', async (field) => {
    const session = createProjectSession({ projectRoot: execution.projectRoot, flowSessionId: execution.flowSessionId,
      getExecution: () => ({ ...execution, [field]: field === 'role' ? 'canvas' : 'other' }) })
    await expect(session.run('work', [], null, () => {})).rejects.toThrow('another conversation or role')
  })
})
