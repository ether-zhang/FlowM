import type { HarnessRuntimePolicy } from './types'

export function runtimePolicy(phase: HarnessRuntimePolicy['phase']): HarnessRuntimePolicy {
  if (phase === 'project') return { phase, tools: 'workspace', timeoutSecs: 600 }
  if (phase === 'inspect') return { phase, tools: 'inspect', timeoutSecs: 600 }
  return { phase, tools: 'none', timeoutSecs: 600 }
}

export function inspectionRequest(prompt: string): string {
  return `${prompt}\n\nFlowM runtime stage: inspect only. Read relevant project code if needed. Return concise source-grounded findings for the following canvas stage; if no code inspection is needed, say so and finish. Do not draw, announce readiness through commands, run placeholder commands such as echo, or keep calling tools after gathering the needed context. No canvas operation is executed in this stage.`
}
