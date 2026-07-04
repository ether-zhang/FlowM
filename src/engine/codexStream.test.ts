import { describe, expect, it } from 'vitest'
import { createCodexStderrFilter, extractCodexThreadId, interpretCodexLine, isIgnorableCodexStderr } from './codexStream'

describe('interpretCodexLine', () => {
  it('maps a thread start to a system note and extracts the thread id', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: '019f2dce-19e8-7041-91ca-f093be49fcd4' })
    expect(interpretCodexLine(line)).toEqual([{ kind: 'system', text: '▶ Codex · 019f2dce-19e8-7041-91ca-f093be49fcd4' }])
    expect(extractCodexThreadId(line)).toBe('019f2dce-19e8-7041-91ca-f093be49fcd4')
  })

  it('maps completed assistant items to text', () => {
    expect(interpretCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'assistant_message', text: 'hi' } }))).toEqual([
      { kind: 'text', text: 'hi' },
    ])
  })

  it('maps errors to compact system notes', () => {
    expect(interpretCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'no auth' } }))).toEqual([
      { kind: 'system', text: 'Codex 出错: no auth' },
    ])
  })

  it('tolerates non-JSON and unknown events', () => {
    expect(interpretCodexLine('not json')).toEqual([])
    expect(interpretCodexLine(JSON.stringify({ type: 'unknown' }))).toEqual([])
  })
})

describe('isIgnorableCodexStderr', () => {
  it('filters known non-actionable Codex stderr noise', () => {
    expect(isIgnorableCodexStderr('Reading prompt from stdin...')).toBe(true)
    expect(
      isIgnorableCodexStderr(
        '2026-07-04T16:02:36.408246Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit',
      ),
    ).toBe(true)
    expect(
      isIgnorableCodexStderr(
        '2026-07-04T16:02:37.888522Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer error=\\"invalid_request\\", error_description=\\"No access token was provided in this request\\", resource_metadata=\\"https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/\\"" })',
      ),
    ).toBe(true)
  })

  it('keeps real stderr visible', () => {
    expect(isIgnorableCodexStderr('unexpected fatal error')).toBe(false)
    expect(
      isIgnorableCodexStderr(
        'ERROR codex_core::exec: exec error: windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to launch helper: helper=codex-windows-sandbox-setup.exe, cwd=D:\\Project\\vllm, error=program not found',
      ),
    ).toBe(false)
  })
})

describe('createCodexStderrFilter', () => {
  it('folds Codex tool-router command failure dumps', () => {
    const filter = createCodexStderrFilter()
    expect(filter('2026-07-04T16:30:58.227476Z ERROR codex_core::tools::router: error=Exit code: 1')).toBeNull()
    expect(filter('Wall time: 0.2 seconds')).toBeNull()
    expect(filter('Total output lines: 4293')).toBeNull()
    expect(filter('Output:')).toBeNull()
    expect(filter('vllm/v1/metrics/stats.py:162:class KVCacheEvictionEvent:')).toBeNull()
    expect(filter('')).toBeNull()
    expect(filter('unexpected fatal error')).toBe('unexpected fatal error')
  })

  it('keeps sandbox helper failures visible', () => {
    const filter = createCodexStderrFilter()
    const line =
      'ERROR codex_core::exec: exec error: windows sandbox: orchestrator_helper_launch_failed: helper=codex-windows-sandbox-setup.exe'
    expect(filter(line)).toBe(line)
  })

  it('resumes on a new Codex error line after a folded dump', () => {
    const filter = createCodexStderrFilter()
    expect(filter('2026-07-04T16:30:58.227476Z ERROR codex_core::tools::router: error=Exit code: 1')).toBeNull()
    expect(filter('Output:')).toBeNull()
    expect(filter('2026-07-04T16:31:00.000000Z ERROR codex_core::exec: real failure')).toBe(
      '2026-07-04T16:31:00.000000Z ERROR codex_core::exec: real failure',
    )
  })
})
