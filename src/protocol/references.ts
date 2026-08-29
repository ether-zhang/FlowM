import type { CanvasOp } from './schema'
import type { StructureRelation } from './structure'

export interface ReferenceResolution<T> {
  value: T
  unresolved: string[]
}

type ReferenceLookup = (key: string) => string | undefined

function resolver(lookup: ReferenceLookup) {
  const unresolved = new Set<string>()
  const key = (value: string): string => {
    const resolved = lookup(value)
    if (resolved) return resolved
    unresolved.add(value)
    return value
  }
  return { key, unresolved }
}

/**
 * Resolve every shape reference carried by an operation. Unknown keys are preserved so
 * callers can either defer the operation or report them without losing the original intent.
 */
export function resolveCanvasOpReferences(
  op: CanvasOp,
  lookup: ReferenceLookup,
): ReferenceResolution<CanvasOp> {
  const { key, unresolved } = resolver(lookup)
  let value: CanvasOp
  switch (op.op) {
    case 'connect_shapes':
      value = { ...op, from: key(op.from), to: key(op.to) }
      break
    case 'move_shape':
    case 'update_text':
    case 'delete_shape':
      value = { ...op, id: key(op.id) }
      break
    case 'place_region':
      value = {
        ...op,
        ids: op.ids.map(key),
        ...(op.anchorId ? { anchorId: key(op.anchorId) } : {}),
      }
      break
    default:
      value = op
  }
  return { value, unresolved: [...unresolved] }
}

/** Resolve refs in a model-declared layout relation after its create batch has real ids. */
export function resolveStructureRelationReferences(
  relation: StructureRelation,
  lookup: ReferenceLookup,
): ReferenceResolution<StructureRelation> {
  const { key, unresolved } = resolver(lookup)
  const value: StructureRelation = relation.kind === 'contain'
    ? { ...relation, parent: key(relation.parent), children: relation.children.map(key) }
    : { ...relation, nodes: relation.nodes.map(key) }
  return { value, unresolved: [...unresolved] }
}
