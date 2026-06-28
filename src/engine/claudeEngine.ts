import { claudeRun, writeDesign, mcpStart, type ClaudeEvent } from './claudeCode'
import { interpretClaudeLine, extractStructured } from './claudeStream'
import { buildBuildPrompt, buildDrawPrompt, buildCanvasPrompt } from './prompt'
import { DIAGRAM_JSON_SCHEMA, parseDiagram, type DiagramSpec } from './diagram'
import { layoutDiagram } from './diagramLayout'
import { formatCanvas, type CanvasPort } from '../protocol'
import type { ChatEngine, ChatCallbacks } from './chatEngine'

type Mode = 'build' | 'draw' | 'mcp'

/**
 * The local Claude Code engine: spawn the user's `claude` CLI in a project directory and
 * stream its work into the chat. Three directions, picked by `mode` (one engine entry each):
 *
 *  - 'build' (画布 → 工程): the canvas design (shape spec + design.png) is attached to the
 *    prompt so the drawing drives the build. Continuity comes from the persistent project dir.
 *  - 'draw'  (工程 → 画布, one-shot): Claude reads the code and returns a structure (nodes/edges)
 *    as a `--json-schema` result; FlowM lays it out and draws it back onto the canvas.
 *  - 'mcp'   (画布 ↔, live): Claude edits the LIVE canvas directly through FlowM's local canvas
 *    MCP server (see mcpCanvas / mcp.rs) — it can see the selection and edit incrementally.
 *
 * Composes the Tauri transport (claudeCode) with the pure stream interpreter (claudeStream),
 * prompt builders, and the pure diagram layout; knows nothing about React. Desktop (Tauri) only.
 */
export class ClaudeEngine implements ChatEngine {
  readonly id: string
  readonly label: string
  private mode: Mode
  private getCwd: () => string
  private getPort: () => CanvasPort | null

  constructor(getCwd: () => string, getPort: () => CanvasPort | null, mode: Mode = 'build') {
    this.getCwd = getCwd
    this.getPort = getPort
    this.mode = mode
    this.id = mode === 'draw' ? 'claude-draw' : mode === 'mcp' ? 'claude-canvas' : 'claude'
    this.label = mode === 'draw' ? 'Claude Code · 画结构' : mode === 'mcp' ? 'Claude Code · 画布' : 'Claude Code'
  }

  async send(text: string, cb: ChatCallbacks): Promise<void> {
    const cwd = this.getCwd().trim()
    if (!cwd) throw new Error('请先填写工程目录')
    if (this.mode === 'draw') return this.draw(text, cwd, cb)
    if (this.mode === 'mcp') return this.canvasEdit(text, cwd, cb)

    const prompt = await this.composePrompt(text, cwd, cb)
    await claudeRun(prompt, cwd, this.streamToChat(cb))
  }

  /** Stream Claude's stdout (prose + tool activity) into the chat; report stderr / non-zero
   *  exit. Shared by build and mcp modes (draw mode also captures the structured result, so
   *  it inlines its own handler). */
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

  /** Canvas-edit (MCP) mode: ensure FlowM's local canvas MCP server is up, spawn Claude with
   *  it attached, and let Claude read/edit the live canvas via the mcp__flowm__* tools. The
   *  user's selection (the anchor) is captured NOW and pushed into the prompt — reliable and
   *  visible — while get_canvas stays for live re-reads. */
  private async canvasEdit(text: string, cwd: string, cb: ChatCallbacks): Promise<void> {
    const url = await mcpStart()
    const sel = this.selectionSpec()
    const prompt = buildCanvasPrompt(text, sel?.spec)
    const mcpConfig = JSON.stringify({ mcpServers: { flowm: { type: 'http', url } } })
    cb.onSystem('▶ 连接画布 MCP，开始编辑…')
    if (sel) cb.onSystem(`📎 已附上选区（${sel.count} 个形状）`)
    cb.onDebug?.(`▷ 发往 Claude Code 的提示:\n${prompt}\n\n--mcp-config: ${mcpConfig}`)
    await claudeRun(prompt, cwd, this.streamToChat(cb), undefined, undefined, mcpConfig)
  }

  /** The user's current selection as a spec (with ids) for pushing into a prompt; undefined
   *  when nothing is explicitly selected (selectionScope is null → the model can get_canvas). */
  private selectionSpec(): { spec: string; count: number } | undefined {
    const port = this.getPort()
    if (!port || !port.selectionScope()) return undefined
    const shapes = port.snapshot('selection')
    if (shapes.length === 0) return undefined
    return { spec: formatCanvas(shapes), count: shapes.length }
  }

  /** Draw mode: stream Claude's exploration as usual, capture its structured result, then
   *  lay it out and draw it on the canvas (beside any existing content). */
  private async draw(text: string, cwd: string, cb: ChatCallbacks): Promise<void> {
    const port = this.getPort()
    if (!port) throw new Error('画布不可用')

    cb.onSystem('▶ 读代码并生成结构…')
    // Debug parity with the canvas engine (which dumps its model request): show what we SEND.
    // There's no single "request" beyond this — the CLI runs its own agentic loop, whose steps
    // surface live as the 🔧 tool stream; the response side is the structured JSON dumped below.
    const prompt = buildDrawPrompt(text)
    cb.onDebug?.(`▷ 发往 Claude Code 的提示（输出 schema 固定为 nodes/edges）:\n${prompt}`)
    // Held on an object, not a `let`: TS can't see the streamed callback runs, so a plain
    // variable would be narrowed to null after the await. Keep the RAW structured output too,
    // so debug mode shows exactly what Claude returned (vs how FlowM laid it out) — the key
    // signal for telling a messy graph apart from a layout bug.
    const captured: { spec: DiagramSpec | null; raw: unknown } = { spec: null, raw: null }
    await claudeRun(
      prompt,
      cwd,
      (e) => {
        if (e.kind === 'stdout') {
          for (const item of interpretClaudeLine(e.line)) {
            if (item.kind === 'text') cb.onText(item.text)
            else cb.onSystem(item.text)
          }
          const structured = extractStructured(e.line)
          if (structured) {
            captured.raw = structured
            captured.spec = parseDiagram(structured)
          }
        } else if (e.kind === 'stderr') {
          cb.onSystem('⚠ ' + e.line)
        } else if (e.code !== 0) {
          cb.onSystem(`— 进程退出 ${e.code} —`)
        }
      },
      undefined,
      DIAGRAM_JSON_SCHEMA,
    )

    cb.onDebug?.(`◁ Claude 返回的结构化输出:\n${captured.raw != null ? JSON.stringify(captured.raw, null, 2) : '(无)'}`)
    const spec = captured.spec
    if (!spec || spec.nodes.length === 0) {
      cb.onSystem('⚠ 未得到可绘制的结构')
      return
    }
    const ops = layoutDiagram(spec, nextOrigin(port))
    await port.apply(ops)
    const edges = ops.length - spec.nodes.length
    cb.onSystem(`✓ 已在画布绘制 ${spec.nodes.length} 个节点 · ${edges} 条连线`)
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

/** Top-left for a freshly drawn diagram: to the right of all existing shapes, so it never
 *  lands on top of the user's current work (empty canvas → a small inset from the origin). */
function nextOrigin(port: CanvasPort): { x: number; y: number } {
  const shapes = port.snapshot('all')
  if (shapes.length === 0) return { x: 120, y: 120 }
  let maxX = -Infinity
  for (const s of shapes) maxX = Math.max(maxX, s.x + (s.w ?? 120))
  return { x: (Number.isFinite(maxX) ? maxX : 0) + 160, y: 120 }
}
