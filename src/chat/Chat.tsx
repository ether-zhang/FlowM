import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DisplayMessage } from './types'

export interface ChatProps {
  messages: DisplayMessage[]
  busy: boolean
  /** Whether the selected engine can send right now (key set / dir filled). */
  canSend: boolean
  apiKeySet: boolean
  debug: boolean
  /** Engines to choose between; the selector hides itself when there's only one. */
  engines: { id: string; label: string }[]
  engineId: string
  onSelectEngine: (id: string) => void
  /** Engine-specific config row (e.g. a cwd input), owned by the caller. */
  engineConfig?: React.ReactNode
  placeholder: string
  onSend: (text: string) => void
  onConfigureKey: () => void
  onToggleDebug: () => void
  onSave: () => void
  onLoad: () => void
}

export function Chat({
  messages,
  busy,
  canSend,
  apiKeySet,
  debug,
  engines,
  engineId,
  onSelectEngine,
  engineConfig,
  placeholder,
  onSend,
  onConfigureKey,
  onToggleDebug,
  onSave,
  onLoad,
}: ChatProps) {
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  // True between compositionstart/end — an IME is mid-composition (candidate window open).
  const composingRef = useRef(false)

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
        {engines.length > 1 && (
          <select
            value={engineId}
            onChange={(e) => onSelectEngine(e.target.value)}
            title="选择引擎：画布助手 / Claude Code"
            style={{ marginLeft: 8 }}
          >
            {engines.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <button onClick={onSave} title="保存工程">保存</button>
        <button onClick={onLoad} title="加载工程">加载</button>
        <button
          onClick={onToggleDebug}
          title="调试模式：显示每次发送给模型的请求"
          aria-pressed={debug}
        >
          {debug ? 'Debug ✓' : 'Debug'}
        </button>
        <button onClick={onConfigureKey} title="设置 Poe API Key">
          {apiKeySet ? 'Key ✓' : 'Key'}
        </button>
      </header>

      {engineConfig && (
        <div className="chat-engine-config" style={{ padding: '4px 8px', borderBottom: '1px solid #eee' }}>
          {engineConfig}
        </div>
      )}

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <p className="chat-hint">
            在画布上放置或手绘图形，选中后在这里向大模型描述需求；模型可直接修改画布。
          </p>
        )}
        {messages.map((m) => {
          if (m.role === 'debug') {
            return (
              <details key={m.id} className="msg msg-debug">
                <summary>发送给模型的请求{m.image ? '（含图片）' : ''}</summary>
                <pre>{m.text}</pre>
                {m.image && <img className="debug-image" src={m.image} alt="发送给模型的画布缩略图" />}
              </details>
            )
          }
          if (m.role === 'assistant') {
            return (
              <div key={m.id} className="msg msg-assistant">
                {m.text ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                ) : busy ? (
                  '…'
                ) : null}
              </div>
            )
          }
          return (
            <div key={m.id} className={`msg msg-${m.role}`}>
              {m.text}
            </div>
          )
        })}
      </div>

      <div className="chat-input">
        <textarea
          value={text}
          placeholder={placeholder}
          disabled={!canSend || busy}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => (composingRef.current = true)}
          onCompositionEnd={() => (composingRef.current = false)}
          onKeyDown={(e) => {
            // Enter sends — but never while an IME is composing (Enter then commits the candidate).
            // Three guards because no single one is reliable across webviews: `isComposing`
            // (Chrome/Windows), our composition ref, and keyCode 229 — macOS WebKit (Tauri) reports
            // the composition-ending Enter as 229 with isComposing already false. Shift+Enter = newline.
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              !composingRef.current &&
              e.keyCode !== 229
            ) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button onClick={send} disabled={!canSend || busy || !text.trim()}>
          {busy ? '…' : '发送'}
        </button>
      </div>
    </div>
  )
}
