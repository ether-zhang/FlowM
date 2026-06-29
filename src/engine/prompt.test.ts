import { describe, it, expect } from 'vitest'
import { buildBuildPrompt } from './prompt'

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
