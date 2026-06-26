import {
  type CanvasPort,
  type CanvasOp,
  canvasTools,
  formatCanvas,
  parseOp,
  toolCallToOp,
} from '../protocol'
import type { LlmAdapter, RunTurnParams } from './adapter'
import type { LlmMessage } from './types'

const SYSTEM = `You are FlowM's canvas assistant. You collaborate with the user on an infinite 2D canvas — it may hold structured flowcharts/diagrams OR free-form notes, sketches and hand-drawn strokes (like a whiteboard / 无边记 board).

- Before each user message you are given the current canvas (selection, or whole canvas) two ways: (1) a list of shapes with their ids, types, page coordinates (top-left), sizes and text, AND (2) an IMAGE of that same selection/canvas. Use the image to see the actual layout, hand-drawn strokes, colors and visual intent that the shape list can't fully convey.
- Judge intent from the user's request AND the image, then pick the right output:
  - a STRUCTURED flowchart — rectangles=steps, diamonds=decisions, ellipses=start/end, connected by arrows in flow order — when they want a process/diagram;
  - a FREE-FORM arrangement — shapes and text laid out spatially to express or annotate an idea, no rigid flow or arrows — when they're sketching, brainstorming, or organizing notes.
  Don't force a flowchart when free arrangement fits, and vice versa.
- You can both answer in words AND modify the canvas by calling the provided tools. When the user asks you to draw, arrange, or edit, USE THE TOOLS.
- Coordinates are page space: x grows right, y grows down. Default shapes are ~120 wide × 80 tall.
- Space shapes GENEROUSLY so connecting arrows are clearly visible and shapes never overlap: leave at least ~100px of empty gap between adjacent shapes. In practice, for a top-to-bottom flowchart step each node ~200px down (y += 200); for a left-to-right layout step ~260px across (x += 260). Diamonds and shapes with long labels are bigger — give them extra room.
- To connect shapes, give each new shape a short \`ref\` and pass those refs (or existing shape ids from the canvas context) to connect_shapes. You can create and connect in the same response, or connect shapes from earlier turns by their id — arrows bind to their endpoints and follow them when moved either way.
- For flowcharts: rectangle = step, diamond = decision, ellipse = start/end. Connect with arrows in flow order.
- Lay flowcharts on a VERTICAL SPINE: the main path (start → steps → the success/"是" branch of each decision → end) runs straight down a single shared column (same x, increasing y), with the terminal/end node placed directly BELOW the last node — not off to one side. Send only the SECONDARY exits sideways: a decision's "否"/failure branch and loop-backs leave from the side and return to the spine, so the main flow reads as one clean top-to-bottom line.
- Keep prose brief; let the canvas do the talking.`

const MAX_ITERATIONS = 8

export interface SendCallbacks {
  onText(text: string): void
  /** Fired after a batch of canvas ops is applied, with a short human summary. */
  onToolsApplied(summary: string): void
  /**
   * Debug hook: fired right before each model call with the exact request
   * (system + message history + tools) for that loop iteration. `iteration` is
   * 0-based. Used by the UI's debug mode to show what was sent to the model.
   */
  onRequest?(params: RunTurnParams, iteration: number): void
}

/** Holds the provider-neutral message history and runs the tool-use loop for one user turn. */
export class Conversation {
  private history: LlmMessage[] = []
  private adapter: LlmAdapter

  constructor(adapter: LlmAdapter) {
    this.adapter = adapter
  }

  reset(messages: LlmMessage[] = []) {
    this.history = messages
  }

  get messages(): LlmMessage[] {
    return this.history
  }

  async send(userText: string, port: CanvasPort, cb: SendCallbacks): Promise<void> {
    const context = formatCanvas(port.snapshot('selection'))
    const image = await port.exportImage('selection')

    // Keep only the newest turn's image: vision tokens are costly and stale
    // snapshots add little once the canvas has moved on.
    for (const m of this.history) if (m.role === 'user') delete m.image

    this.history.push({
      role: 'user',
      content: `Current canvas:\n${context}\n\n---\n${userText}`,
      ...(image ? { image } : {}),
    })

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const params: RunTurnParams = { system: SYSTEM, messages: this.history, tools: canvasTools }
      cb.onRequest?.(params, i)
      const turn = await this.adapter.runTurn(params, { onText: cb.onText })
      this.history.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls })

      if (turn.toolCalls.length === 0) return

      // Validate each tool call into a CanvasOp, then apply the valid ones as one
      // batch so create-refs resolve for later ops (e.g. connect_shapes).
      const validOps: CanvasOp[] = []
      const meta: { id: string; error?: string }[] = []
      for (const tc of turn.toolCalls) {
        try {
          validOps.push(parseOp(toolCallToOp(tc.name, tc.args)))
          meta.push({ id: tc.id })
        } catch (e) {
          meta.push({ id: tc.id, error: (e as Error).message })
        }
      }
      const results = port.apply(validOps)

      let vi = 0
      let applied = 0
      for (const m of meta) {
        if (m.error) {
          this.history.push({ role: 'tool', toolCallId: m.id, content: `error: ${m.error}` })
          continue
        }
        const r = results[vi++]
        if (r.ok) applied++
        this.history.push({ role: 'tool', toolCallId: m.id, content: JSON.stringify(r) })
      }

      cb.onToolsApplied(`已对画布执行 ${applied}/${turn.toolCalls.length} 个操作`)
    }
  }
}
