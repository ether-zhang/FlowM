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

const SYSTEM = `You are FlowM's canvas assistant. You collaborate with the user on an infinite 2D canvas of flowchart-like shapes.

- Before each user message you are given the current canvas (selection, or whole canvas) as a list of shapes with their ids, types, page coordinates (top-left), sizes and text.
- You can both answer in words AND modify the canvas by calling the provided tools. When the user asks you to draw, arrange, or edit, USE THE TOOLS.
- Coordinates are page space: x grows right, y grows down. Default shapes are ~120 wide × 80 tall.
- Space shapes GENEROUSLY so connecting arrows are clearly visible and shapes never overlap: leave at least ~100px of empty gap between adjacent shapes. In practice, for a top-to-bottom flowchart step each node ~200px down (y += 200); for a left-to-right layout step ~260px across (x += 260). Diamonds and shapes with long labels are bigger — give them extra room.
- To reference shapes you create within the same turn (e.g. to connect them), give each create a short \`ref\` and use that ref in connect_shapes.
- For flowcharts: rectangle = step, diamond = decision, ellipse = start/end. Connect with arrows in flow order.
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
    this.history.push({ role: 'user', content: `Current canvas:\n${context}\n\n---\n${userText}` })

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
