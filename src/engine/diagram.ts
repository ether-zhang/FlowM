import { z } from 'zod'

/**
 * The diagram contract for "project → canvas": Claude reads code and returns a structure
 * as nodes + edges (NOT positions — FlowM lays it out, see [[diagramLayout]]). Two forms
 * kept in sync by hand: the zod schema (validates Claude's output) and DIAGRAM_JSON_SCHEMA
 * (the JSON Schema handed to `claude --json-schema`, which forces a validated result). Pure
 * — no canvas/LLM/Tauri deps; the same contract serves the deterministic-render path now
 * and an incremental MCP path later.
 */

/** A node's role → which geo shape it becomes (see [[diagramLayout]]'s KIND_TO_GEO). */
export const NODE_KINDS = ['process', 'decision', 'terminal', 'data'] as const

const DiagramNode = z.object({
  id: z.string().min(1),
  label: z.string(),
  kind: z.enum(NODE_KINDS).optional(),
})
const DiagramEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional(),
})
export const DiagramSpec = z.object({
  title: z.string().optional(),
  /** Overall reading direction the layout flows along (default 'down'). */
  dir: z.enum(['down', 'right']).optional(),
  nodes: z.array(DiagramNode),
  edges: z.array(DiagramEdge),
})
export type DiagramSpec = z.infer<typeof DiagramSpec>
export type DiagramNode = z.infer<typeof DiagramNode>
export type DiagramEdge = z.infer<typeof DiagramEdge>

/** Validate Claude's structured output into a DiagramSpec, or null if malformed. */
export function parseDiagram(input: unknown): DiagramSpec | null {
  const r = DiagramSpec.safeParse(input)
  return r.success ? r.data : null
}

/**
 * JSON Schema passed to `claude --json-schema`. Mirrors DiagramSpec above. Descriptions are
 * the model's only guidance for what to put where, so they carry the intent ("main structure
 * only", id conventions, what each kind means).
 */
export const DIAGRAM_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '图的标题（可选）' },
    dir: {
      type: 'string',
      enum: ['down', 'right'],
      description: '整体阅读方向：down = 自上而下（默认），right = 自左向右',
    },
    nodes: {
      type: 'array',
      description: '关键组件 / 模块 / 步骤。只画主干结构，10~20 个为宜，不要逐行罗列。',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '短的唯一 id，如 "n1"、"cache"；edges 用它引用' },
          label: { type: 'string', description: '框内文字，尽量短（≤6 词）' },
          kind: {
            type: 'string',
            enum: ['process', 'decision', 'terminal', 'data'],
            description:
              'process=普通处理框(矩形), decision=判断/分支(菱形), terminal=入口/出口(椭圆), data=数据/存储(矩形)。不确定就省略。',
          },
        },
        required: ['id', 'label'],
      },
    },
    edges: {
      type: 'array',
      description: '节点之间的调用 / 数据流 / 依赖关系。让连线表达真实结构。',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '起点 node id' },
          to: { type: 'string', description: '终点 node id' },
          label: { type: 'string', description: '连线上的简短说明（可选）' },
        },
        required: ['from', 'to'],
      },
    },
  },
  required: ['nodes', 'edges'],
} as const
