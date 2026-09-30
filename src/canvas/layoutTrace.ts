import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { CanvasOp, StructureRelation } from '../protocol'
import type { LayoutBox } from './layout'

export interface LayoutTraceStage {
  name: 'before' | 'materialized' | 'spacing' | 'overlap' | 'routing'
  elements: readonly ExcalidrawElement[]
  candidate?: readonly LayoutBox[]
  accepted: boolean
  issues: string[]
}

export interface LayoutTrace {
  operations: readonly CanvasOp[]
  relations: readonly StructureRelation[]
  stages: LayoutTraceStage[]
  diagnostics: string[]
}

const traces: LayoutTrace[] = []

/** Bounded, local-only diagnostics; no scene is uploaded or written to project files. */
export function readLayoutTraces(): LayoutTrace[] {
  return structuredClone(traces)
}

export function clearLayoutTraces(): void {
  traces.length = 0
}

export function recordLayoutTrace(trace: LayoutTrace): void {
  traces.push(structuredClone(trace))
  if (traces.length > 8) traces.shift()
  if (typeof window !== 'undefined') {
    window.__flowmLayout = { getTraces: readLayoutTraces, clear: clearLayoutTraces }
  }
}

declare global {
  interface Window {
    __flowmLayout?: { getTraces: typeof readLayoutTraces; clear: typeof clearLayoutTraces }
  }
}
