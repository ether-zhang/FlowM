import type Anthropic from '@anthropic-ai/sdk'
import {
  type CanvasPort,
  type CanvasOp,
  canvasTools,
  formatCanvas,
  parseOp,
  toolCallToOp,
} from '../protocol'
import type { LlmAdapter } from './adapter'

const SYSTEM = `You are FlowM's canvas assistant. You collaborate with the user on an infinite 2D canvas of flowchart-like shapes.

- Before each user message you are given the current canvas (selection, or whole canvas) as a list of shapes with their ids, types, page coordinates (top-left), sizes and text.
- You can both answer in words AND modify the canvas by calling the provided tools. When the user asks you to draw, arrange, or edit, USE THE TOOLS.
- Coordinates are page space: x grows right, y grows down. Lay shapes out with comfortable spacing (e.g. ~160px horizontal pitch).
- To reference shapes you create within the same turn (e.g. to connect them), give each create a short \`ref\` and use that ref in connect_shapes.
- For flowcharts: rectangle = step, diamond = decision, ellipse = start/end. Connect with arrows in flow order.
- Keep prose brief; let the canvas do the talking.`

const MAX_ITERATIONS = 8

export interface SendCallbacks {
  onText(delta: string): void
  /** Fired after a batch of canvas ops is applied, with a short human summary. */
  onToolsApplied(summary: string): void
}

/** Holds the API-level message history and runs the tool-use loop for one user turn. */
export class Conversation {
  private apiMessages: Anthropic.MessageParam[] = []
  private adapter: LlmAdapter

  constructor(adapter: LlmAdapter) {
    this.adapter = adapter
  }

  reset(messages: Anthropic.MessageParam[] = []) {
    this.apiMessages = messages
  }

  get messages(): Anthropic.MessageParam[] {
    return this.apiMessages
  }

  async send(userText: string, port: CanvasPort, cb: SendCallbacks): Promise<void> {
    const context = formatCanvas(port.snapshot('selection'))
    this.apiMessages.push({
      role: 'user',
      content: `Current canvas:\n${context}\n\n---\n${userText}`,
    })

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const msg = await this.adapter.streamTurn(
        { system: SYSTEM, messages: this.apiMessages, tools: canvasTools },
        { onText: cb.onText },
      )
      this.apiMessages.push({ role: 'assistant', content: msg.content })

      const toolUses = msg.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )
      if (toolUses.length === 0) return

      // Validate each tool call into a CanvasOp, then apply the valid ones as one
      // batch so create-refs resolve for later ops (e.g. connect_shapes).
      const validOps: CanvasOp[] = []
      const meta: { id: string; error?: string }[] = []
      for (const tu of toolUses) {
        try {
          validOps.push(parseOp(toolCallToOp(tu.name, tu.input as Record<string, unknown>)))
          meta.push({ id: tu.id })
        } catch (e) {
          meta.push({ id: tu.id, error: (e as Error).message })
        }
      }
      const results = port.apply(validOps)

      let vi = 0
      let applied = 0
      const toolResults: Anthropic.ToolResultBlockParam[] = meta.map((m) => {
        if (m.error) {
          return { type: 'tool_result', tool_use_id: m.id, is_error: true, content: m.error }
        }
        const r = results[vi++]
        if (r.ok) applied++
        return { type: 'tool_result', tool_use_id: m.id, is_error: !r.ok, content: JSON.stringify(r) }
      })

      cb.onToolsApplied(`已对画布执行 ${applied}/${toolUses.length} 个操作`)
      this.apiMessages.push({ role: 'user', content: toolResults })
    }
  }
}
