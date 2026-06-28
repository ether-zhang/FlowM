import { useState } from 'react'
import { claudeRun, type ClaudeEvent } from './claudeCode'

/**
 * Spike UI: a tiny floating panel to prove the local Claude Code pipe end-to-end —
 * spawn `claude` in a project dir, stream its output, confirm subscription auth works
 * (no API key). Desktop-only; not the final UX, just the de-risking harness.
 */
const box: React.CSSProperties = {
  position: 'fixed',
  left: 8,
  bottom: 8,
  width: 540,
  height: 320,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 6,
  background: '#1e1e1e',
  color: '#ddd',
  border: '1px solid #444',
  borderRadius: 6,
  font: '12px ui-monospace, monospace',
  zIndex: 1000,
}
const field: React.CSSProperties = { background: '#111', color: '#ddd', border: '1px solid #333', padding: '3px 5px' }

export function ClaudePanel() {
  const [cwd, setCwd] = useState('D:\\Project\\vLLM')
  const [bin, setBin] = useState('')
  const [prompt, setPrompt] = useState('用一句话说明你现在在哪个目录，并列出该目录下的文件')
  const [log, setLog] = useState<string[]>([])
  const [running, setRunning] = useState(false)

  const run = async () => {
    setLog([])
    setRunning(true)
    const push = (s: string) => setLog((l) => [...l, s])
    try {
      await claudeRun(
        prompt,
        cwd,
        (e: ClaudeEvent) => {
          if (e.kind === 'stdout') push(e.line)
          else if (e.kind === 'stderr') push('[stderr] ' + e.line)
          else push(`— exit ${e.code} —`)
        },
        bin.trim() || undefined,
      )
    } catch (err) {
      push('[spawn error] ' + ((err as Error)?.message ?? String(err)))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={box}>
      <div style={{ display: 'flex', gap: 4 }}>
        <input style={{ ...field, flex: 1 }} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="工程目录 (cwd)" />
        <button onClick={run} disabled={running}>
          {running ? '运行中…' : 'Run claude'}
        </button>
      </div>
      <input style={field} value={bin} onChange={(e) => setBin(e.target.value)} placeholder="claude 可执行路径（留空=PATH 上的 claude）" />
      <input style={field} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="prompt" />
      <pre style={{ flex: 1, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap' }}>{log.join('\n')}</pre>
    </div>
  )
}
