import { type Editor, getSnapshot, loadSnapshot } from 'tldraw'
import type Anthropic from '@anthropic-ai/sdk'
import type { DisplayMessage } from '../chat/types'

const VERSION = 1

/** A saved FlowM project: the canvas plus the conversation (display + API history). */
export interface Project {
  version: number
  canvas: ReturnType<typeof getSnapshot>
  display: DisplayMessage[]
  api: Anthropic.MessageParam[]
}

export function buildProject(
  editor: Editor,
  display: DisplayMessage[],
  api: Anthropic.MessageParam[],
): Project {
  return { version: VERSION, canvas: getSnapshot(editor.store), display, api }
}

export function restoreCanvas(editor: Editor, project: Project) {
  loadSnapshot(editor.store, project.canvas)
}

/** Browser fallback persistence: download the project as a .json file. */
export function downloadProject(project: Project, name = 'flowm-project') {
  const blob = new Blob([JSON.stringify(project)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.flowm.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** Browser fallback: open a file picker and parse the chosen project. */
export function openProjectFile(): Promise<Project | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      try {
        const project = JSON.parse(await file.text()) as Project
        resolve(project)
      } catch {
        resolve(null)
      }
    }
    input.click()
  })
}
