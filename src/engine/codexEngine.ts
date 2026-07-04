import { codexRun } from './codexCli'
import { createCodexStderrFilter, interpretCodexLine } from './codexStream'
import { writeDesign } from './claudeCode'
import { buildBuildPrompt } from './prompt'
import { formatCanvas, type CanvasPort } from '../protocol'
import type { ChatCallbacks, ChatEngine } from './chatEngine'

/** Local Codex CLI engine for project work. It mirrors ClaudeEngine, but spawns `codex exec`. */
export class CodexEngine implements ChatEngine {
  readonly id = 'codex'
  readonly label = 'Codex CLI'
  private getCwd: () => string
  private getPort: () => CanvasPort | null
  private getBin: () => string
  private session: string | null = null

  constructor(getCwd: () => string, getPort: () => CanvasPort | null, getBin: () => string) {
    this.getCwd = getCwd
    this.getPort = getPort
    this.getBin = getBin
  }

  async send(text: string, cb: ChatCallbacks): Promise<void> {
    const cwd = this.getCwd().trim()
    if (!cwd) throw new Error('请先打开工程')
    const prompt = await this.composePrompt(text, cwd, cb)
    let streamedText = false
    const stderrFilter = createCodexStderrFilter()
    const last = await codexRun(prompt, cwd, (e) => {
      if (e.kind === 'stdout') {
        const sid = extractSession(e.line)
        if (sid) this.session = sid
        for (const item of interpretCodexLine(e.line)) {
          if (item.kind === 'text') {
            streamedText = true
            cb.onText(item.text)
          } else {
            cb.onSystem(item.text)
          }
        }
      } else if (e.kind === 'stderr') {
        const line = stderrFilter(e.line)
        if (line) cb.onSystem('⚠ ' + line)
      } else if (e.code !== 0) {
        cb.onSystem(`进程退出 ${e.code}`)
      }
    }, {
      bin: this.getBin().trim() || undefined,
      resume: this.session ?? undefined,
      readOnly: false,
    })
    if (!streamedText && last?.trim()) cb.onText(last.trim())
  }

  private async composePrompt(text: string, cwd: string, cb: ChatCallbacks): Promise<string> {
    const port = this.getPort()
    if (!port) return text
    const shapes = port.snapshot('selection')
    if (shapes.length === 0) return text

    cb.onSystem('附上画布设计...')
    const spec = formatCanvas(shapes)
    const image = await port.exportImage('selection')
    const designPath = image ? await writeDesign(cwd, image) : '(画布图片导出失败)'
    return buildBuildPrompt(text, spec, designPath)
  }
}

function extractSession(line: string): string | null {
  try {
    const ev = JSON.parse(line)
    if (ev?.type === 'thread.started' && typeof ev.thread_id === 'string') return ev.thread_id
  } catch {
    // ignore non-JSON stderr/stdout
  }
  return null
}
