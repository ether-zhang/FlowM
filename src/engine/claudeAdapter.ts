import { claudeRun, writeDesign } from './claudeCode'
import { interpretClaudeLine, extractStructured } from './claudeStream'
import type { LlmAdapter, RunTurnParams, TurnCallbacks, LlmTurn, LlmToolCall, LlmMessage } from '../llm'
import type { ToolDef } from '../protocol'

/**
 * Claude Code as a model backend for FlowM's EXISTING canvas pipeline — the seam adapter.ts
 * always intended ("an agent bridge (claude code) is just another implementation — the
 * conversation loop and the rest of the app never change"). It does NOT bypass the pipeline:
 * the Conversation serializes the canvas (text + image) and asks for operations; this adapter
 * spawns `claude`, hands it that exact context plus the operation list, and constrains the
 * output with `--json-schema` to { text, operations[] }. Claude may read project code on the
 * way (its file tools) before returning the operations; the framework then applies them (with
 * the layout passes) and runs the review gate — byte-identical flow to the Poe adapter.
 *
 * The prompt builder and result parser are pure (exported for tests); only runTurn touches the
 * Tauri transport. Desktop (Tauri) only — there is no local CLI to spawn in a browser.
 */
export class ClaudeAdapter implements LlmAdapter {
  private getCwd: () => string

  constructor(getCwd: () => string) {
    this.getCwd = getCwd
  }

  async runTurn(params: RunTurnParams, cb: TurnCallbacks): Promise<LlmTurn> {
    const cwd = this.getCwd().trim()
    if (!cwd) throw new Error('请先填写工程目录')

    // The newest user message carries the canvas render (the Conversation drops older images);
    // write it out so Claude can Read it as the visual of what it's editing.
    const imaged = [...params.messages].reverse().find((m): m is Extract<LlmMessage, { role: 'user' }> => m.role === 'user' && !!m.image)
    const imagePath = imaged?.image ? await writeDesign(cwd, imaged.image) : null

    const prompt = buildTurnPrompt(params, imagePath)
    let streamed = ''
    let structured: unknown = null
    await claudeRun(
      prompt,
      cwd,
      (e) => {
        if (e.kind !== 'stdout') return
        for (const item of interpretClaudeLine(e.line)) {
          // Only the prose narration goes to the chat bubble; the 🔧 tool stream is dropped
          // (it would clutter the assistant reply — the applied-ops summary is the feedback).
          if (item.kind === 'text') {
            streamed += item.text
            cb.onText(item.text)
          }
        }
        const s = extractStructured(e.line)
        if (s) structured = s
      },
      undefined,
      turnSchema(params.tools),
    )

    return parseClaudeTurn(structured, streamed)
  }
}

/** The `--json-schema` for one canvas turn: a short reply plus an ordered list of operations,
 *  each naming one of the available tools (validated downstream by the protocol's parseOp). */
export function turnSchema(tools: ToolDef[]) {
  return {
    type: 'object',
    properties: {
      text: { type: 'string', description: '给用户的简短回复（可空）' },
      operations: {
        type: 'array',
        description: '要在画布上执行的操作，按顺序；没有要做的就给空数组',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: tools.map((t) => t.name) },
            args: { type: 'object', description: '该操作的参数；见系统说明里每个操作的参数 schema' },
          },
          required: ['tool', 'args'],
        },
      },
    },
    required: ['operations'],
  }
}

/** Serialize (system + history + tools) into Claude's prompt. Pure — the same context Poe gets
 *  over the wire, flattened to text, plus a note to Read the rendered canvas image. */
export function buildTurnPrompt(params: RunTurnParams, imagePath: string | null): string {
  const toolDocs = params.tools.map((t) => `- ${t.name}：${t.description}\n  参数 schema：${JSON.stringify(t.parameters)}`).join('\n')
  const convo = params.messages.map(serializeMessage).join('\n\n')
  return `${params.system}

────────【可用操作】────────
你不能直接调用这些工具改画布；你通过「结构化输出」返回一组操作，由 FlowM 执行。每个操作 = { "tool": <名字>, "args": {…} }。可用操作：
${toolDocs}

────────【对话】────────
${convo}${imagePath ? `\n\n（当前画布渲染图：${imagePath} —— 先 Read 它，看实际布局、颜色、手绘与选区）` : ''}

────────【你的回合】────────
需要时用你的文件工具（Read / Grep）读项目代码，理解结构。然后用 StructuredOutput 返回 { "text": "...", "operations": [ {tool, args}, … ] }。已经满足要求、没有要做的，就返回空 operations。`
}

function serializeMessage(m: LlmMessage): string {
  if (m.role === 'user') return `[用户] ${m.content}${m.image ? '（附画布渲染图，见下）' : ''}`
  if (m.role === 'assistant') {
    const ops = m.toolCalls?.length ? `\n  （已执行操作：${JSON.stringify(m.toolCalls.map((t) => ({ tool: t.name, args: t.args })))}）` : ''
    return `[助手] ${m.content}${ops}`
  }
  return `[操作结果 ${m.toolCallId}] ${m.content}`
}

/** Parse Claude's structured turn into the provider-neutral LlmTurn (operations → tool calls).
 *  Malformed entries are skipped; the validated ones feed the same apply path Poe's do. */
export function parseClaudeTurn(structured: unknown, fallbackText: string): LlmTurn {
  const r = (structured ?? {}) as { text?: unknown; operations?: unknown }
  const ops = Array.isArray(r.operations) ? r.operations : []
  const toolCalls: LlmToolCall[] = []
  for (const o of ops) {
    if (o && typeof o === 'object' && typeof (o as { tool?: unknown }).tool === 'string') {
      const op = o as { tool: string; args?: Record<string, unknown> }
      toolCalls.push({ id: crypto.randomUUID(), name: op.tool, args: op.args ?? {} })
    }
  }
  const text = typeof r.text === 'string' && r.text ? r.text : fallbackText
  return { text, toolCalls }
}
