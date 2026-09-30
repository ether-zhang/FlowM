import { useId, useState } from 'react'
import type { AgentModel } from '../agent'
import type { UiText } from './uiText'

const CUSTOM = '__flowm_custom_model__'

export function ModelPicker({
  value, models, onChange, disabled, loading = false, error, onRefresh, text,
}: {
  value: string
  models: readonly AgentModel[]
  onChange: (model: string) => void
  disabled: boolean
  loading?: boolean
  error?: string | null
  onRefresh?: () => void
  text: UiText
}) {
  const id = useId()
  const [customOpen, setCustomOpen] = useState(false)
  const selected = value === 'default' ? '' : value
  const custom = customOpen || !!selected && !models.some((model) => model.id === selected)
  return (
    <div className="model-picker">
      <div className="model-picker-row">
        <label htmlFor={id}>{text.model.label}</label>
        <select
          id={id}
          value={custom ? CUSTOM : selected}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value
            setCustomOpen(next === CUSTOM)
            if (next !== CUSTOM) onChange(next)
          }}
        >
          <option value="">{models.find((model) => model.id === 'default')?.label ?? text.model.default}</option>
          {models.filter((model) => model.id !== 'default').map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          <option value={CUSTOM}>{text.model.custom}</option>
        </select>
        {onRefresh && (
          <button type="button" disabled={disabled || loading} title={text.model.refresh} aria-label={text.model.refresh} onClick={onRefresh}>
            {loading ? '…' : '↻'}
          </button>
        )}
      </div>
      {custom && (
        <input
          className="model-custom-input"
          aria-label={text.model.custom}
          placeholder={text.model.placeholder}
          value={value}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value.trim())}
        />
      )}
      {loading ? <div className="model-picker-note" role="status">{text.model.loading}</div>
        : error ? <div className="model-picker-note" title={error}>{text.model.loadFailed}</div> : null}
    </div>
  )
}
