import type { HarnessModel } from '../harness'

export interface PublisherGroup { id: string; label: string; models: HarnessModel[] }

/** UI ordering preserves upstream IDs, candidate admission and default selection. */
export function groupModelsByPublisher(models: readonly HarnessModel[], otherLabel: string): PublisherGroup[] {
  const groups = new Map<string, PublisherGroup>()
  const compare = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })
  for (const model of models) {
    const prefix = model.id.includes('/') ? model.id.slice(0, model.id.indexOf('/')) : ''
    const named = model.label.includes(':') ? model.label.slice(0, model.label.indexOf(':')).trim() : ''
    const publisher = prefix || named
    const id = publisher.toLowerCase() || ''
    let group = groups.get(id)
    if (!group) {
      group = { id, label: named || (publisher ? publisher[0].toUpperCase() + publisher.slice(1) : otherLabel), models: [] }
      groups.set(id, group)
    }
    group.models.push(model)
  }
  return [...groups.values()].sort((a, b) => a.id ? b.id ? compare(a.id, b.id) : -1 : b.id ? 1 : 0)
    .map((group) => ({ ...group, models: group.models.toSorted((a, b) => compare(a.label, b.label) || compare(a.id, b.id)) }))
}
