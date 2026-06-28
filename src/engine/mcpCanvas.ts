import {
  canvasTools,
  declareStructureTool,
  formatCanvas,
  parseOp,
  parseStructure,
  resolveScope,
  toolCallToOp,
  type CanvasPort,
  type ToolDef,
} from '../protocol'

/**
 * Renderer side of FlowM's canvas MCP server: the Rust transport (mcp.rs) bridges each
 * `tools/list` / `tools/call` from the spawned `claude` to here, and this turns it into work
 * on the live CanvasPort, returning the MCP result shape. The tool DEFINITIONS are protocol's
 * existing canvasTools + declareStructureTool — the very ones the Poe canvas assistant uses
 * (single source of truth) — plus a read-only `get_canvas`. Pure orchestration over the port:
 * no Tauri, no React (the App wires the event bridge to this), so it's unit-testable.
 */

/** A read tool so Claude can SEE the canvas (esp. the user's selection) before editing it. */
const GET_CANVAS: ToolDef = {
  name: 'get_canvas',
  description:
    "Read the current FlowM canvas as a shape list (ids, types, page coords, sizes, text). Call this FIRST to see what exists and what the user selected — scope:'selection' (default) returns the user's selected region, scope:'all' the whole canvas. Use the returned ids in connect_shapes / move_shape / declare_structure.",
  parameters: {
    type: 'object',
    properties: { scope: { type: 'string', enum: ['selection', 'all'], description: "default 'selection'" } },
  },
}

/** The MCP tools we expose = read tool + every canvas op + the structure declaration. */
const MCP_TOOLS: ToolDef[] = [GET_CANVAS, ...canvasTools, declareStructureTool]

const toMcpTool = (t: ToolDef) => ({ name: t.name, description: t.description, inputSchema: t.parameters })
const textResult = (text: string) => ({ content: [{ type: 'text', text }] })
const errorResult = (text: string) => ({ content: [{ type: 'text', text }], isError: true })

/**
 * Handle one bridged MCP request, returning its JSON-RPC `result`. A `tools/call` result
 * carries the op outcome as text — INCLUDING any new shape id, so Claude chains create →
 * connect by real id (refs don't survive across separate MCP calls; each call is one apply).
 */
export async function handleMcpRequest(method: string, params: unknown, port: CanvasPort | null): Promise<unknown> {
  if (method === 'tools/list') return { tools: MCP_TOOLS.map(toMcpTool) }
  if (method !== 'tools/call') return errorResult(`unsupported method: ${method}`)

  const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
  const name = p.name ?? ''
  const args = p.arguments ?? {}
  if (!port) return errorResult('canvas unavailable')

  try {
    if (name === 'get_canvas') {
      const scope = args.scope === 'all' ? 'all' : 'selection'
      return textResult(formatCanvas(port.snapshot(scope)))
    }
    if (name === 'declare_structure') {
      const parsed = parseStructure(args)
      await port.apply([], resolveScope(parsed.relations))
      return textResult(
        `declared ${parsed.relations.length} relation(s)` + (parsed.errors.length ? `; dropped ${parsed.errors.length}` : ''),
      )
    }
    // Otherwise a canvas op: validate against the protocol schema, then apply one batch.
    const op = parseOp(toolCallToOp(name, args))
    const [res] = await port.apply([op])
    return textResult(JSON.stringify(res))
  } catch (e) {
    return errorResult((e as Error).message)
  }
}
