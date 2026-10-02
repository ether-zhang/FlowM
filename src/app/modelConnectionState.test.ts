import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { HarnessProfile } from '../harness'
import { activeModelConnection } from '../harness/connections'
import { HarnessSettings } from './HarnessSettings'
import { uiText } from './uiText'

const gpt: HarnessProfile = { id: 'gpt', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', authKind: 'chatgpt', credentialVersion: 1, account: 'test@example.com', subject: null, clientId: null, signedIn: true }
const gateway: HarnessProfile = { ...gpt, id: 'gateway', name: 'Gateway', kind: 'gateway', authKind: 'none', account: null }

describe('model connection UI', () => {
  it('uses the selected authenticated connection when migrating existing preferences', () => {
    expect(activeModelConnection([gateway, gpt], 'gpt', undefined)?.id).toBe('gpt')
  })
  it('keeps all options available after explicit logout, even for a gateway without authentication', () => {
    expect(activeModelConnection([gateway, gpt], 'gateway', null)).toBeNull()
  })
  it('does not silently switch to another saved account when the active one loses authentication', () => {
    expect(activeModelConnection([{ ...gpt, signedIn: false }, gateway], 'gpt', 'gpt')).toBeNull()
  })
  it('renders the active account with adjacent sign-out and disables all connection selectors', () => {
    const html = renderToStaticMarkup(createElement(HarnessSettings, {
      profiles: [gpt, gateway], profile: gpt, disabled: false, loginPending: false,
      onSave: async (profile) => profile, onLogin: async () => {}, onLogout: async () => {}, onConnect: async () => {}, onCancelLogin: async () => {}, text: uiText.zh,
    }))
    expect(html).toContain('大模型接口')
    expect(html).toContain('GPT 登录')
    expect(html).toContain('Claude 登录')
    expect(html).toContain('Gateway')
    expect(html).toContain('test@example.com')
    expect(html.match(/class="model-connection-option[^"]*" disabled=""/g)).toHaveLength(3)
    expect(html).toMatch(/class="model-disconnect"[^>]*>退出登录/)
    expect(html).not.toContain('gateway-connection-form')
  })
})
