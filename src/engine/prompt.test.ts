import { describe, it, expect } from 'vitest'
import { buildBuildPrompt, buildDrawPrompt, buildCanvasPrompt } from './prompt'

describe('buildBuildPrompt', () => {
  it('keeps the user instruction first, then attaches the design path and spec', () => {
    const out = buildBuildPrompt('实现这个推理引擎', '- #s1 rectangle @(0,0) 120x80 text="入口"', '.flowm/design.png')
    expect(out.startsWith('实现这个推理引擎')).toBe(true)
    expect(out).toContain('.flowm/design.png')
    expect(out).toContain('#s1 rectangle @(0,0) 120x80 text="入口"')
    // instruction comes before the spec
    expect(out.indexOf('实现这个推理引擎')).toBeLessThan(out.indexOf('#s1 rectangle'))
  })
})

describe('buildDrawPrompt', () => {
  it('keeps the user instruction first and asks for a structured nodes/edges result', () => {
    const out = buildDrawPrompt('读一下 prefix cache 模块')
    expect(out.startsWith('读一下 prefix cache 模块')).toBe(true)
    expect(out).toContain('StructuredOutput')
    expect(out).toContain('nodes')
    expect(out).toContain('edges')
  })
})

describe('buildCanvasPrompt', () => {
  it('explains the mcp__flowm__ tools and omits the anchor when there is no selection', () => {
    const out = buildCanvasPrompt('扩展这部分')
    expect(out.startsWith('扩展这部分')).toBe(true)
    expect(out).toContain('mcp__flowm__')
    expect(out).not.toContain('用户当前在画布上选中')
  })

  it('pushes the selection spec (the anchor) into the prompt when present', () => {
    const out = buildCanvasPrompt('扩展这部分', '- #s1 rectangle @(0,0) 120x80 text="alloc"')
    expect(out).toContain('用户当前在画布上选中')
    expect(out).toContain('#s1 rectangle')
  })
})
