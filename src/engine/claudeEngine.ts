import { claudeRun, writeDesign, type ClaudeEvent } from './claudeCode'
import { interpretClaudeLine } from './claudeStream'
import { buildBuildPrompt } from './prompt'
import { formatCanvas, type CanvasPort } from '../protocol'
import type { ChatEngine, ChatCallbacks } from './chatEngine'

/**
 * The local Claude Code "build" engine (画布 → 工程): spawn the user's `claude` CLI in a
 * project directory and stream its work into the chat. When the canvas holds a design it's
 * attached (shape spec + design.png) so the drawing drives the build; continuity comes from the
 * persistent project dir. Composes the Tauri transport with the pure stream interpreter and the
 * prompt builder; knows nothing about React. Desktop (Tauri) only.
 *
 * (Drawing back ONTO the canvas is the separate ClaudeCanvasEngine — model produces a CanvasPlan,
 * the framework renders it.)
 */
export class ClaudeEngine implements ChatEngine {
  readonly id = 'claude'
  readonly label = 'Claude Code'
  private getCwd: () => string
  private getPort: () => CanvasPort | null
  /** Path to the `claude` executable (empty → let the backend resolve `claude` via PATH). */
  private getBin: () => string

  constructor(getCwd: () => string, getPort: () => CanvasPort | null, getBin: () => string) {
    this.getCwd = getCwd
    this.getPort = getPort
    this.getBin = getBin
  }

  async send(text: string, cb: ChatCallbacks): Promise<void> {
    const cwd = this.getCwd().trim()
    if (!cwd) throw new Error('请先填写工程目录')
    const prompt = await this.composePrompt(text, cwd, cb)
    await claudeRun(prompt, cwd, this.streamToChat(cb), this.getBin().trim() || undefined)
  }

  /** Stream Claude's stdout (prose + tool activity) into the chat; report stderr / non-zero exit. */
  private streamToChat(cb: ChatCallbacks) {
    return (e: ClaudeEvent) => {
      if (e.kind === 'stdout') {
        for (const item of interpretClaudeLine(e.line)) {
          if (item.kind === 'text') cb.onText(item.text)
          else cb.onSystem(item.text)
        }
      } else if (e.kind === 'stderr') {
        cb.onSystem('⚠ ' + e.line)
      } else if (e.code !== 0) {
        cb.onSystem(`— 进程退出 ${e.code} —`)
      }
    }
  }

  /** Attach the current canvas design (spec + design.png) when there is one; otherwise the
   *  message is sent as-is, so Claude Code also works as a plain coding agent on the dir. */
  private async composePrompt(text: string, cwd: string, cb: ChatCallbacks): Promise<string> {
    const port = this.getPort()
    if (!port) return text
    const shapes = port.snapshot('selection')
    if (shapes.length === 0) return text

    cb.onSystem('📎 附上画布设计…')
    const spec = formatCanvas(shapes)
    const image = await port.exportImage('selection')
    const designPath = image ? await writeDesign(cwd, image) : '(画布图导出失败)'
    return buildBuildPrompt(text, spec, designPath)
  }
}
