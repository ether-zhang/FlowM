import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openProject, projectDirName, saveProject } from './store'

const io = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke }))

describe('old FlowM project metadata', () => {
  beforeEach(() => { io.invoke.mockReset() })
  it('retains legacy session handles and independent canvas names while adding private bindings', async () => {
    const folder = 'E:\\old-project'
    const projectId = projectDirName(folder)
    const files = new Map<string, string>([
      ['workspace.json', JSON.stringify({ version: 1, projects: [{ id: projectId, folder, name: 'old-project', lastOpened: 1 }] })],
      [`${projectId}/project.json`, JSON.stringify({ version: 1, folder, sessions: [{ id: 's', name: 'Old conversation', sessionId: 'old-claude', codexSessionId: 'old-codex' }], canvases: [{ id: 'c', name: 'Old diagram' }] })],
    ])
    io.invoke.mockImplementation(async (command: string, params: { rel: string; content?: string }) => {
      if (command === 'flowm_read') return files.get(params.rel) ?? null
      if (command === 'flowm_write') { files.set(params.rel, params.content!); return }
      throw new Error(`Unexpected native command: ${command}`)
    })
    const { id, meta } = await openProject(folder)
    meta.sessions[0].harnessThreads = { 'private-binding': 'private-thread' }
    await saveProject(id, meta)
    const saved = JSON.parse(files.get(`${projectId}/project.json`)!)
    expect(saved.sessions[0]).toMatchObject({ name: 'Old conversation', sessionId: 'old-claude', codexSessionId: 'old-codex', harnessThreads: { 'private-binding': 'private-thread' } })
    expect(saved.canvases).toEqual([{ id: 'c', name: 'Old diagram' }])
    expect(io.invoke.mock.calls.every(([command]) => ['flowm_read', 'flowm_write'].includes(command as string))).toBe(true)
  })
})
