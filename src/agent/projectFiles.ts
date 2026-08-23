import { invoke } from '@tauri-apps/api/core'

/** Write the rendered canvas under the active project for local agents to inspect. */
export async function writeDesign(cwd: string, dataUrl: string): Promise<string> {
  return invoke<string>('write_design', { cwd, dataUrl })
}

export async function writeClaudeCanvasGuide(cwd: string, content: string): Promise<string> {
  return invoke<string>('write_claude_canvas_guide', { cwd, content })
}

export async function writeCodexCanvasGuide(cwd: string, content: string): Promise<string> {
  return invoke<string>('write_codex_canvas_guide', { cwd, content })
}
