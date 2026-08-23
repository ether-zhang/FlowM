import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(
  [
    './protocol/**/*.{ts,tsx}',
    './agent/**/*.{ts,tsx}',
    './agentControl/**/*.{ts,tsx}',
    './llm/**/*.{ts,tsx}',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

function sourceFiles(folder: string): Array<[string, string]> {
  const prefix = `./${folder}/`
  return Object.entries(sources).filter(
    ([path]) => path.startsWith(prefix) && !path.includes('.test.'),
  )
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((value): value is string => value != null)
}

function forbiddenImports(folder: string, pattern: RegExp): string[] {
  return sourceFiles(folder).flatMap(([path, source]) =>
    importsOf(source)
      .filter((specifier) => pattern.test(specifier))
      .map((specifier) => `${path} -> ${specifier}`),
  )
}

describe('module dependency direction', () => {
  it('keeps protocol independent of outer application layers', () => {
    expect(forbiddenImports('protocol', /^\.\.\//)).toEqual([])
  })

  it('keeps neutral agent contracts independent of application layers', () => {
    expect(forbiddenImports('agent', /^\.\.\/(?:app|canvas|chat|engine|llm|workspace)(?:\/|$)/)).toEqual([])
  })

  it('keeps agent transports independent of orchestration and UI layers', () => {
    expect(forbiddenImports('agentControl', /^\.\.\/(?:app|canvas|chat|engine|llm|workspace)(?:\/|$)/)).toEqual([])
  })

  it('keeps LLM orchestration independent of UI, workspace, and engine implementations', () => {
    expect(forbiddenImports('llm', /^\.\.\/(?:app|canvas|chat|engine|workspace)(?:\/|$)/)).toEqual([])
  })
})
