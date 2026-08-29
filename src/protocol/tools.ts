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

const shapeKeyDescription =
  'Existing shape id, or a ref assigned by create_geo/create_text anywhere in the current user turn.'

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
    name: 'place_region',
    description:
      'Ask the FlowM framework to place a group of non-arrow shapes into a nearby free slot. The shapes may be existing ids or refs created in the same user turn. Use this instead of guessing far-away coordinates when a region overlaps/crowds existing content. The framework keeps the listed shapes together, treats unlisted shapes as obstacles, finds the final empty area, moves the group as one unit, and re-routes attached arrows.',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: `Explicit shapes to move together. ${shapeKeyDescription} List only shapes you are allowed to move.`,
        },
        prefer: {
          type: 'string',
          enum: ['right', 'below', 'left', 'above', 'nearest'],
          description: 'Preferred placement direction relative to anchorId, or relative to the region itself when anchorId is omitted.',
        },
        anchorId: { type: 'string', description: `Optional shape to place near. ${shapeKeyDescription}` },
        margin: { type: 'number', description: 'Optional minimum clear gap in page pixels.' },
      },
      required: ['ids'],
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

export const declareDiagramTool: ToolDef = {
  name: 'declare_diagram',
  description:
    'Declare the semantic plan for a structured diagram before it is materialized. This is a non-drawing operation: it fixes the process/structure/mixed choice, the explanation focus, semantic regions, and the refs of primary/supporting shapes. Include it in the same operation batch as the creates; FlowM compiles the whole batch before drawing. Scope and detail follow the user request rather than a fixed node quota.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['process', 'structure', 'mixed'] },
      focus: {
        type: 'string',
        description: 'One sentence naming the exact mechanism and scope the diagram will explain.',
      },
      regions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Short stable region key; not a canvas shape id.' },
            kind: { type: 'string', enum: ['process', 'structure'] },
            purpose: { type: 'string', description: 'What this region contributes to the explanation.' },
            primaryRefs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Refs of the semantic content nodes in this region.',
            },
            supportingRefs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional refs for region containers or essential context nodes.',
            },
          },
          required: ['ref', 'kind', 'purpose', 'primaryRefs'],
        },
      },
    },
    required: ['kind', 'focus', 'regions'],
  },
}

/**
 * The structure-declaration tool (not an op — it doesn't mutate shapes; it tells the
 * framework how to lay a region out). Nodes use existing shape ids or create refs, so the
 * model can declare structure before the concrete canvas ids exist. Use it
 * by judgment — only where a real structure applies; skip free-form work. JSON Schema
 * can't express the per-kind field union, so every possible field is listed with only
 * `kind` required; parseStructure (zod) validates the real per-kind shape and drops
 * malformed relations.
 */
export const declareStructureTool: ToolDef = {
  name: 'declare_structure',
  description:
    'Declare the layout STRUCTURE of a region so the framework positions it precisely — ONLY where a real structure applies (a chain of connected nodes, a grid, a nested group). Skip it entirely for free-form arrangements; not everything is a flow. Reference shapes by existing ids or refs assigned by create operations anywhere in the current user turn. Kinds: flow (a chain down a column / across a row → straightened + evenly spaced), align (share a row or column), grid (uniform matrix), contain (a parent box holding children), nonOverlap (must not overlap), freeze (leave exactly as drawn).',
  parameters: {
    type: 'object',
    properties: {
      relations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['flow', 'align', 'grid', 'contain', 'nonOverlap', 'freeze'] },
            nodes: { type: 'array', items: { type: 'string' }, description: 'shape ids or refs this relation applies to' },
            parent: { type: 'string', description: 'contain: the container shape id or ref' },
            children: { type: 'array', items: { type: 'string' }, description: 'contain: the contained shape ids or refs' },
            dir: { type: 'string', enum: ['down', 'right'], description: 'flow: chain direction' },
            axis: { type: 'string', enum: ['col', 'row'], description: 'align: shared axis' },
            at: { type: 'string', enum: ['min', 'center', 'max'], description: 'align: where on the axis' },
            cols: { type: 'integer', description: 'grid: number of columns' },
            gap: { type: 'number', description: 'grid: gap between cells' },
          },
          required: ['kind'],
        },
      },
    },
    required: ['relations'],
  },
}

/** Turn a tool name + parsed args into a CanvasOp shape (adds the `op` discriminator). */
export function toolCallToOp(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { op: name, ...args }
}
