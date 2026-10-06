import { useId } from 'react'
import type { HarnessModelCatalog } from '../harness'
import type { UiText } from './uiText'
import { groupModelsByPublisher } from './modelGroups'

export function ModelPicker({
  value, catalog, connection, onChange, disabled, loading = false, error, text,
}: {
  value: string
  catalog: HarnessModelCatalog | null
  connection?: { label: string; account?: string | null } | null
  onChange: (model: string) => void
  disabled: boolean
  loading?: boolean
  error?: string | null
  text: UiText
}) {
  const id = useId()
  const models = catalog?.models ?? []
  const selectedModel = models.find((model) => model.id === value)
  const selected = selectedModel?.id ?? ''
  return (
    <div className="model-picker">
      <div className="model-picker-row">
        {connection && <span className="model-picker-connection" title={connection.account || text.harness.connected}>
          <span className="connection-status-dot online" aria-hidden="true" />
          <span>{connection.label}</span>
        </span>}
        <label htmlFor={id}>{text.model.label}</label>
      </div>
      <div className="model-picker-control">
        <select
          id={id}
          value={selected}
          disabled={disabled || loading || !models.length}
          aria-busy={loading || undefined}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="" disabled>{loading ? text.model.loading : text.model.select}</option>
          {catalog?.source === 'gateway'
            ? groupModelsByPublisher(models, text.model.otherPublisher).map((group) => <optgroup key={group.id} label={group.label}>
              {group.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </optgroup>)
            : models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
        <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
      </div>
      {!loading && error && <div className="model-picker-note" role="alert">{text.model.loadFailed} {error}</div>}
    </div>
  )
}
