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
    ])} disabled={false} onChange={() => {}} text={uiText.en} />)
    expect(html).toContain('GPT models')
    expect(html).toContain('value="gpt-account-model" selected=""')
    expect(html).toContain('Account model')
    expect(html).toContain('model-picker-id')
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
    const html = renderToStaticMarkup(<ModelPicker value="claude-route" catalog={catalog([], 'gateway')} disabled={false} onChange={() => {}} text={uiText.zh} />)
    expect(html).toContain('来自 Gateway')
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
  it('offers an official candidate with an honest access note and no text input', () => {
    const html = renderToStaticMarkup(<ModelPicker value="gpt-6.1-sol" catalog={catalog([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', origin: 'kernel' },
    ])} disabled={false} onChange={() => {}} text={uiText.zh} />)
    expect(html).toContain('value="gpt-6.1-sol" selected=""')
    expect(html).toContain('访问待确认')
    expect(html).toContain('官方候选模型')
    expect(html).not.toContain('<input')
  })
})
