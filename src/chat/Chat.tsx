import { useEffect, useRef, useState } from 'react'
import type { DisplayMessage } from './types'

export interface ChatProps {
  messages: DisplayMessage[]
  busy: boolean
  apiKeySet: boolean
  onSend: (text: string) => void
  onConfigureKey: () => void
  onSave: () => void
  onLoad: () => void
}

export function Chat({ messages, busy, apiKeySet, onSend, onConfigureKey, onSave, onLoad }: ChatProps) {
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const send = () => {
    const t = text.trim()
    if (!t || busy) return
    onSend(t)
    setText('')
  }

  return (
    <div className="chat">
      <header className="chat-bar">
        <strong>FlowM</strong>
        <span className="spacer" />
        <button onClick={onSave} title="保存工程">保存</button>
        <button onClick={onLoad} title="加载工程">加载</button>
        <button onClick={onConfigureKey} title="设置 Claude API Key">
          {apiKeySet ? 'Key ✓' : 'Key'}
        </button>
      </header>

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <p className="chat-hint">
            在画布上放置或手绘图形，选中后在这里向大模型描述需求；模型可直接修改画布。
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {m.text || (m.role === 'assistant' && busy ? '…' : '')}
          </div>
        ))}
      </div>

      <div className="chat-input">
        <textarea
          value={text}
          placeholder={apiKeySet ? '描述你想让模型做什么…（Enter 发送）' : '请先设置 API Key'}
          disabled={!apiKeySet || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button onClick={send} disabled={!apiKeySet || busy || !text.trim()}>
          {busy ? '…' : '发送'}
        </button>
      </div>
    </div>
  )
}
