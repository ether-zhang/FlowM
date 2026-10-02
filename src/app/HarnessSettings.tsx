import { useId, useState } from 'react'
import type { HarnessProfile } from '../harness'
import { connectionOption, type ModelConnectionOption } from './modelConnectionState'
import type { UiText } from './uiText'

function defaultProfile(kind: 'openai' | 'gateway'): HarnessProfile {
  return { id: crypto.randomUUID(), name: kind === 'openai' ? 'OpenAI' : 'Gateway', kind,
    baseUrl: kind === 'openai' ? 'https://api.openai.com/v1' : '', model: kind === 'openai' ? 'gpt-5.5' : '',
    authKind: kind === 'openai' ? 'chatgpt' : 'bearer', credentialVersion: 0, account: null, subject: null, clientId: null }
}

export function HarnessSettings({ profiles, profile, disabled, loginPending, onSave, onLogin, onLogout, onConnect, onCancelLogin, text }: {
  profiles: HarnessProfile[]
  profile: HarnessProfile | null
  disabled: boolean
  loginPending: boolean
  onSave(profile: HarnessProfile, token?: string): Promise<HarnessProfile>
  onLogin(id: string): Promise<void>
  onLogout(id: string): Promise<void>
  onConnect(id: string): Promise<void>
  onCancelLogin(): Promise<void>
  text: UiText
}) {
  const [expanded, setExpanded] = useState<ModelConnectionOption | null>(null)
  const [gateway, setGateway] = useState<HarnessProfile>(() => profiles.find((item) => item.kind === 'gateway') ?? defaultProfile('gateway'))
  const [token, setToken] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const id = useId()
  const t = text.harness
  const locked = disabled || working || loginPending
  const active = profile ? connectionOption(profile) : null
  const options = [
    { id: 'gpt' as const, label: t.gptLogin, icon: 'G', description: t.gptDescription },
    { id: 'claude' as const, label: t.claudeLogin, icon: 'C', description: t.claudeDescription },
    { id: 'gateway' as const, label: 'Gateway', icon: '↗', description: t.gatewayDescription },
  ]
  const run = async (operation: () => Promise<unknown>) => {
    setWorking(true)
    setError('')
    try { await operation() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setWorking(false) }
  }
  const choose = (option: ModelConnectionOption) => {
    if (locked || active) return
    setError('')
    if (option === 'gpt') {
      setExpanded(null)
      void run(async () => {
        const existing = profiles.find((item) => item.kind === 'openai' && item.authKind === 'chatgpt')
        const saved = existing ?? await onSave(defaultProfile('openai'))
        await onLogin(saved.id)
      })
    } else {
      if (option === 'gateway' && !gateway.baseUrl) {
        const existing = profiles.find((item) => item.kind === 'gateway')
        if (existing) setGateway(existing)
      }
      setExpanded((current) => current === option ? null : option)
    }
  }
  return (
    <section className="model-connections" aria-labelledby={`${id}-title`}>
      <div className="settings-section-heading">
        <h4 id={`${id}-title`}>{t.title}</h4>
        <span>{active ? t.connected : t.notConnected}</span>
      </div>
      <div className="model-connection-options">
        {options.map((option) => {
          const selected = active === option.id
          const detail = selected ? profile?.account || (option.id === 'gateway' ? profile?.model : t.connected) : option.description
          return (
            <div className={`model-connection-row${selected ? ' connected' : ''}`} key={option.id}>
              <button type="button" className={`model-connection-option${selected ? ' active' : ''}`}
                disabled={locked || !!active} aria-pressed={selected} onClick={() => choose(option.id)}>
                <span className={`model-connection-icon ${option.id}`} aria-hidden="true">{option.icon}</span>
                <span className="model-connection-copy"><strong>{option.label}</strong><span>{detail}</span></span>
                {selected && <span className="model-connection-check" aria-hidden="true">✓</span>}
              </button>
              {selected && <button type="button" className="model-disconnect" disabled={locked} onClick={() => void run(() => onLogout(profile!.id))}>{t.logout}</button>}
            </div>
          )
        })}
      </div>
      {!active && expanded === 'claude' && <p className="model-connection-notice" role="status">{t.claudeUnavailable}</p>}
      {!active && expanded === 'gateway' && <form className="gateway-connection-form" onSubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          const saved = await onSave(gateway, token || undefined)
          setGateway(saved)
          await onConnect(saved.id)
          setToken('')
          setExpanded(null)
        })
      }}>
        <div className="settings-field"><label htmlFor={`${id}-url`}>{t.url}</label>
          <input id={`${id}-url`} className="modal-input" value={gateway.baseUrl} placeholder="https://gateway.example/v1" disabled={locked} spellCheck={false} onChange={(event) => setGateway({ ...gateway, baseUrl: event.target.value })} required /></div>
        <div className="settings-field"><label htmlFor={`${id}-model`}>{text.model.label}</label>
          <input id={`${id}-model`} className="modal-input" value={gateway.model} placeholder={text.model.placeholder} disabled={locked} spellCheck={false} onChange={(event) => setGateway({ ...gateway, model: event.target.value })} required /></div>
        {gateway.authKind !== 'none' && <div className="settings-field"><label htmlFor={`${id}-token`}>Bearer token</label>
          <input id={`${id}-token`} className="modal-input" type="password" autoComplete="off" value={token} disabled={locked} placeholder={t.tokenPlaceholder} onChange={(event) => setToken(event.target.value)} /></div>}
        <label className="gateway-no-auth"><input type="checkbox" checked={gateway.authKind === 'none'} disabled={locked} onChange={(event) => setGateway({ ...gateway, authKind: event.target.checked ? 'none' : 'bearer' })} />{t.noAuthentication}</label>
        <div className="gateway-connection-actions"><button type="submit" disabled={locked || !gateway.baseUrl.trim() || !gateway.model.trim()}>{working ? t.connecting : t.connect}</button></div>
      </form>}
      {loginPending && <div className="model-login-pending" role="status"><span>{t.loginPending}</span><button type="button" disabled={disabled || working} onClick={() => void run(onCancelLogin)}>{text.common.cancel}</button></div>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </section>
  )
}
