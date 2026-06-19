/**
 * Provider-neutral tool definitions, one per canvas op. The model calls these;
 * each tool's input maps 1:1 to a `CanvasOp` (the `op` field is implied by the
 * name). `parameters` is a JSON Schema object; adapters translate it to their
 * provider's wire format (e.g. OpenAI `function.parameters`).
 *
 * Keeping the schemas here, next to the zod ops in schema.ts, makes the two easy
 * to keep in sync.
 */
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const ref = {
  ref: {
    type: 'string',
    description:
      'Optional temporary label for this new shape so later ops in the same turn (e.g. connect_shapes) can reference it before its real id exists.',
  },
} as const

export const canvasTools: ToolDef[] = [
  {
    name: 'create_geo',
    description:
      'Create a geometric shape (box/ellipse/diamond/triangle) at page coordinates. Use diamond for decision nodes in flowcharts.',
    parameters: {
      type: 'object',
      properties: {
        shape: { type: 'string', enum: ['rectangle', 'ellipse', 'diamond', 'triangle'] },
        x: { type: 'number', description: 'top-left x in page space' },
        y: { type: 'number', description: 'top-left y in page space' },
        w: { type: 'number', description: 'width (default 120)' },
        h: { type: 'number', description: 'height (default 80)' },
        text: { type: 'string', description: 'optional label inside the shape' },
        ...ref,
      },
      required: ['shape', 'x', 'y'],
    },
  },
  {
    name: 'create_text',
    description: 'Create a free-standing text label at page coordinates.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
        ...ref,
      },
      required: ['x', 'y', 'text'],
    },
  },
  {
    name: 'move_shape',
    description: 'Move an existing shape to new top-left page coordinates.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id of an existing shape (from the canvas context)' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['id', 'x', 'y'],
    },
  },
  {
    name: 'update_text',
    description: 'Replace the text/label of an existing shape.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'delete_shape',
    description: 'Delete an existing shape by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'connect_shapes',
    description:
      'Draw an arrow from one shape to another. `from`/`to` may be existing shape ids or refs created earlier in this same turn.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        text: { type: 'string', description: 'optional arrow label' },
      },
      required: ['from', 'to'],
    },
  },
]

/** Turn a tool name + parsed args into a CanvasOp shape (adds the `op` discriminator). */
export function toolCallToOp(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { op: name, ...args }
}
