import { describe, expect, it, vi } from 'vitest'
import { CanvasTurnProjection, parseCanvasResult } from './canvasRuntime'
import { HarnessTurn, HarnessSession } from '../harness'
import type { RunTurnParams } from './canvasTurn'
import { canvasTools } from '../protocol'

const params = (phase: RunTurnParams['phase'] = 'build'): RunTurnParams => ({ phase, system: 'ONE CALLER-OWNED CANVAS CONTRACT', messages: [{ role: 'user', content: 'Draw it' }], tools: phase === 'finalize' ? [] : canvasTools })

describe.each(['openai', 'gateway'])('%s canvas conformance', (profileId) => {
  it('passes the exact caller prompt, per-phase schema and inline image to the same runtime contract', async () => {
    const run = vi.fn().mockResolvedValue({ requestId: 'r1', status: 'completed', text: '{"reply":"done","question":null,"operations":[]}' })
    const create = vi.fn(() => ({ run }) as unknown as HarnessSession)
    const adapter = new CanvasTurnProjection(new HarnessTurn({ projectRoot: '/p', flowSessionId: 's', profileId, model: 'model', role: 'canvas', credentialVersion: 1 }, create))
    const build = params()
    build.messages = [{ role: 'user', content: 'Draw it', image: 'data:image/png;base64,test' }]
    await adapter.runTurn(build, {})
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ system: build.system, role: 'canvas', profileId }))
    expect(run.mock.calls[0][1]).toEqual(['data:image/png;base64,test'])
    const finalize = { ...params('finalize'), messages: [...build.messages, { role: 'user' as const, content: 'Give the final explanation' }] }
    await adapter.runTurn(finalize, {})
    expect(run.mock.calls[1][0]).toBe('Give the final explanation')
    expect(run.mock.calls[1][2].properties.operations.maxItems).toBe(0)
  })
  it('projects valid operations and refuses malformed JSON and finalize operations', () => {
    const result = parseCanvasResult('{"reply":"A","question":null,"operations":[{"op":"create_geo","shape":"rectangle","text":"A","x":null}]}', params(), 'stable-request')
    expect(result.toolCalls[0]).toEqual({ id: 'harness-stable-request-0', name: 'create_geo', args: { shape: 'rectangle', text: 'A' } })
    expect(() => parseCanvasResult('{"reply":"missing operations"}', params(), 'r')).toThrow('Incomplete')
    expect(() => parseCanvasResult('```json\n{}\n```', params(), 'r')).toThrow('valid canvas JSON')
    expect(() => parseCanvasResult('{"reply":"bad","operations":[{"op":"delete_shape","id":"x"}]}', params('finalize'), 'r')).toThrow('forbidden')
    expect(() => parseCanvasResult('{"reply":"bad","operations":[null]}', params(), 'r')).toThrow('Incomplete')
  })
  it('does not resend completed input after invalid model output', async () => {
    const run = vi.fn().mockResolvedValueOnce({ requestId: 'r1', status: 'completed', text: 'invalid' }).mockResolvedValueOnce({ requestId: 'r2', status: 'completed', text: '{"reply":"done","question":null,"operations":[]}' })
    const adapter = new CanvasTurnProjection(new HarnessTurn({ projectRoot: '/p', flowSessionId: 's', profileId, model: 'model', role: 'canvas', credentialVersion: 1 }, () => ({ run }) as unknown as HarnessSession))
    await expect(adapter.runTurn(params(), {})).rejects.toThrow('valid canvas JSON')
    await adapter.runTurn({ ...params(), messages: [...params().messages, { role: 'user', content: 'Try again' }] }, {})
    expect(run.mock.calls[1][0]).toBe('Try again')
  })
})
