import { Channel, invoke } from '@tauri-apps/api/core'

export type CodexEvent =
  | { kind: 'stdout'; line: string }
  | { kind: 'stderr'; line: string }
  | { kind: 'exit'; code: number | null }

export async function codexRun(
  prompt: string,
  cwd: string,
  onEvent: (e: CodexEvent) => void,
  opts: {
    bin?: string
    agentCwd?: string
    outputSchema?: unknown
    resume?: string
    image?: string
    readOnly?: boolean
  } = {},
): Promise<string | null> {
  const channel = new Channel<CodexEvent>()
  channel.onmessage = onEvent
  return invoke<string | null>('codex_run', {
    prompt,
    cwd,
    bin: opts.bin ?? null,
    agentCwd: opts.agentCwd ?? null,
    outputSchema: opts.outputSchema != null ? JSON.stringify(opts.outputSchema) : null,
    resume: opts.resume ?? null,
    image: opts.image ?? null,
    readOnly: opts.readOnly ?? false,
    onEvent: channel,
  })
}

export async function defaultCodexBin(): Promise<string> {
  return invoke<string>('default_codex_bin')
}

export async function writeCodexGuide(cwd: string, content: string): Promise<string> {
  return invoke<string>('write_codex_guide', { cwd, content })
}
