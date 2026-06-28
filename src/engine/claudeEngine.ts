import { claudeRun } from './claudeCode'
import { interpretClaudeLine } from './claudeStream'
import type { ChatEngine, ChatCallbacks } from './chatEngine'

/**
 * The local Claude Code engine: spawn the user's `claude` CLI in a project directory and
 * stream its work into the chat. Composes the Tauri transport (claudeCode) with the pure
 * stream interpreter (claudeStream); knows nothing about React. Desktop (Tauri) only.
 * Reads the working directory through a getter so it tracks the current one.
 */
export class ClaudeEngine implements ChatEngine {
  readonly id = 'claude'
  readonly label = 'Claude Code'
  private getCwd: () => string

  constructor(getCwd: () => string) {
    this.getCwd = getCwd
  }

  async send(text: string, cb: ChatCallbacks): Promise<void> {
    const cwd = this.getCwd().trim()
    if (!cwd) throw new Error('请先填写工程目录')
    await claudeRun(text, cwd, (e) => {
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
    })
  }
}
