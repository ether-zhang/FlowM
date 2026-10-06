import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ModelPicker } from './ModelPicker'
import { uiText } from './uiText'
import type { HarnessModelCatalog } from '../harness'
const catalog = (models: HarnessModelCatalog['models'], source: HarnessModelCatalog['source'] = 'openai-account'): HarnessModelCatalog => ({ profileId: 'p', credentialVersion: 1, source, models, defaultModel: models[0]?.id ?? null })

describe('connection model picker', () => {
  it('uses the connected account catalog and actual IDs without a CLI default or manual entry', () => {
    const html = renderToStaticMarkup(<ModelPicker value="gpt-account-model" catalog={catalog([
      { id: 'gpt-account-model', label: 'Account model', origin: 'remote' },
    ])} connection={{ label: 'GPT' }} disabled={false} onChange={() => {}} text={uiText.en} />)
    expect(html).toContain('connection-status-dot online')
    expect(html).toContain('<span>GPT</span>')
    expect(html.indexOf('<span>GPT</span>')).toBeLessThan(html.indexOf('<label'))
    expect(html).toContain('value="gpt-account-model" selected=""')
    expect(html).toContain('Account model')
    expect(html).not.toContain('model-picker-id')
    expect(html).not.toContain('model-picker-source')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('CLI default')
    expect(html).not.toContain('Custom model')
    expect(html).not.toContain('model-custom-input')
  })

  it('does not display a saved selection absent from a newly loaded account catalog', () => {
    const html = renderToStaticMarkup(<ModelPicker value="previous-model" catalog={catalog([
      { id: 'available-model', label: 'Available model', origin: 'remote' },
    ])} disabled={false} onChange={() => {}} text={uiText.en} />)
    expect(html).not.toContain('previous-model')
    expect(html).toContain('Available model')
    expect(html).not.toContain('model-custom-input')
  })

  it('disables an empty gateway directory without a manual input', () => {
    const html = renderToStaticMarkup(<ModelPicker value="claude-route" catalog={catalog([], 'gateway')} connection={{ label: 'Gateway' }} disabled={false} onChange={() => {}} text={uiText.zh} />)
    expect(html).toContain('<span>Gateway</span>')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('value="claude-route"')
  })

  it('excludes a model absent from the upstream response', () => {
    const current = catalog([{ id: 'listed-model', label: 'Listed model', origin: 'remote' }])
    const html = renderToStaticMarkup(<ModelPicker value="gpt-6.1-sol" catalog={current} disabled={false} onChange={() => {}} text={uiText.en} />)
    expect(html).not.toContain('<input')
    expect(html).not.toContain('gpt-6.1-sol')
    expect(html).toContain('Listed model')
  })

  it('keeps default as a valid gateway route rather than a CLI sentinel', () => {
    const html = renderToStaticMarkup(<ModelPicker value="default" catalog={catalog([{ id: 'default', label: 'Upstream route', origin: 'remote' }], 'gateway')} disabled={false} onChange={() => {}} text={uiText.en} />)
    expect(html).toContain('value="default" selected=""')
    expect(html).toContain('Upstream route')
    expect(html).not.toContain('model-custom-input')
  })
  it('shows only the name of an official candidate and waits for actual request errors', () => {
    const html = renderToStaticMarkup(<ModelPicker value="gpt-6.1-sol" catalog={catalog([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', origin: 'kernel' },
    ])} disabled={false} onChange={() => {}} text={uiText.zh} />)
    expect(html).toContain('value="gpt-6.1-sol" selected=""')
    expect(html).toContain('>GPT-6.1-Sol</option>')
    expect(html).not.toContain('访问待确认')
    expect(html).not.toContain('官方候选模型')
    expect(html).not.toContain('model-picker-note')
    expect(html).not.toContain('<input')
  })

  it('shows a returned error as a visible alert instead of a tooltip or availability guess', () => {
    const error = 'Gateway returned 403: model access denied'
    const html = renderToStaticMarkup(<ModelPicker value="" catalog={null} disabled={false} error={error} onChange={() => {}} text={uiText.en} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain(error)
    expect(html).not.toContain('connection-status-dot online')
  })

  it('shows loading inside the disabled selector without adding another hint row', () => {
    const html = renderToStaticMarkup(<ModelPicker value="" catalog={null} disabled={false} loading onChange={() => {}} text={uiText.zh} />)
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('正在读取可用模型')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('model-picker-note')
  })
  it('groups gateway publishers while preserving the selected model and the upstream catalog', () => {
    const current = catalog([
      { id: 'openai/gpt-fixture', label: 'OpenAI: GPT fixture', origin: 'remote' },
      { id: 'anthropic/claude-fixture', label: 'Anthropic: Claude fixture', origin: 'remote' },
    ], 'gateway')
    const html = renderToStaticMarkup(<ModelPicker value="openai/gpt-fixture" catalog={current} disabled={false} onChange={() => {}} text={uiText.zh} />)
    expect(html.indexOf('<optgroup label="Anthropic">')).toBeLessThan(html.indexOf('<optgroup label="OpenAI">'))
    expect(html).toContain('value="openai/gpt-fixture" selected=""')
    expect(current.defaultModel).toBe('openai/gpt-fixture')
    expect(current.models[0].id).toBe('openai/gpt-fixture')
  })
  it('keeps the harness ordering for GPT sign-in', () => {
    const html = renderToStaticMarkup(<ModelPicker value="second" catalog={catalog([
      { id: 'second', label: 'Z model', origin: 'kernel' }, { id: 'first', label: 'A model', origin: 'remote' },
    ])} disabled={false} onChange={() => {}} text={uiText.en} />)
    expect(html).not.toContain('<optgroup')
    expect(html.indexOf('Z model')).toBeLessThan(html.indexOf('A model'))
  })
})
