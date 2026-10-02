import { describe, expect, it, vi } from 'vitest'
import type { CanvasPort } from '../protocol'
import type { DisplayMessage } from '../chat/types'
import type { LlmMessage } from '../llm/types'
import { buildProject, restoreCanvas, type Project } from './project'

describe('portable project compatibility', () => {
  it('retains legacy display and API history when round-tripping an imported project', () => {
    const scene = { elements: [{ id: 'old-shape' }] }
    const display: DisplayMessage[] = [{ id: 'old-user', role: 'user', text: 'Draw the cache' }]
    const api: LlmMessage[] = [
      { role: 'user', content: 'Draw the cache' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old-tool', name: 'create_geo', args: { shape: 'rectangle' } }] },
      { role: 'tool', toolCallId: 'old-tool', content: 'created old-shape' },
    ]
    const imported: Project = { version: 1, canvas: scene, display, api }
    const port = { serialize: () => scene } as unknown as CanvasPort
    expect(JSON.parse(JSON.stringify(buildProject(port, imported.display, imported.api)))).toEqual(imported)
  })

  it('restores a legacy canvas without needing any model connection', () => {
    const scene = { elements: [{ id: 'old-shape' }] }
    const deserialize = vi.fn()
    const port = { deserialize } as unknown as CanvasPort
    restoreCanvas(port, { version: 1, canvas: scene, display: [], api: [] })
    expect(deserialize).toHaveBeenCalledExactlyOnceWith(scene)
  })
})
