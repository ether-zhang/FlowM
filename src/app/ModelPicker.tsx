import { useId } from 'react'
import type { HarnessModelCatalog } from '../harness'
import type { UiText } from './uiText'

export function ModelPicker({
  value, catalog, onChange, disabled, loading = false, error, onRefresh, text,
}: {
  value: string
  catalog: HarnessModelCatalog | null
  onChange: (model: string) => void
  disabled: boolean
  loading?: boolean
  error?: string | null
  onRefresh?: () => void
  text: UiText
}) {
  const id = useId()
  const models = catalog?.models ?? []
  const selectedModel = models.find((model) => model.id === value)
  const selected = selectedModel?.id ?? ''
  return (
    <div className="model-picker">
      <div className="model-picker-row">
        <label htmlFor={id}>{text.model.label}</label>
        <span className="model-picker-source">{catalog?.source === 'gateway' ? text.model.gatewayCatalog : catalog?.source === 'openai-api' ? text.model.apiCatalog : catalog ? text.model.accountCatalog : ''}</span>
        {onRefresh && (
          <button type="button" disabled={disabled || loading} title={text.model.refresh} aria-label={text.model.refresh} onClick={onRefresh}>
            {loading ? '…' : '↻'}
          </button>
        )}
      </div>
      <div className="model-picker-control">
        <select
          id={id}
          value={selected}
          disabled={disabled || loading || !models.length}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="" disabled>{text.model.select}</option>
          {models.map((model) => <option key={model.id} value={model.id}>{model.label}{model.origin === 'kernel' ? ` · ${text.model.candidate}` : ''}</option>)}
        </select>
        <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
      </div>
      {selected && <div className="model-picker-id" title={selected}>{selected}</div>}
      {selectedModel?.origin === 'kernel' && !loading && !error && <div className="model-picker-note">{text.model.candidateNote}</div>}
      {loading ? <div className="model-picker-note" role="status">{text.model.loading}</div>
        : error ? <div className="model-picker-note" title={error}>{text.model.loadFailed}</div> : null}
    </div>
  )
}
