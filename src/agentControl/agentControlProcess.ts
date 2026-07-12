import { Channel, invoke } from '@tauri-apps/api/core'

export type AgentControlProcessEvent =
  | { kind: 'stdout'; line: string }
  | { kind: 'stderr'; line: string }
  | { kind: 'exit'; code: number | null }

export interface ClaudeControlProcessOptions {
  bin?: string
  cwd: string
  jsonSchema?: unknown
  resume?: string
  disallowedTools?: string[]
  appendSystemPrompt?: string
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

interface CodexAppServerStart {
  processId: string
  sandboxMode: CodexSandboxMode
}

/** Thin renderer-side handle for a long-lived Tauri child process. */
export class AgentControlProcess {
  private readonly id: string

  private constructor(id: string) {
    this.id = id
  }

  static async startCodex(
    bin: string | undefined,
    cwd: string,
    readOnly: boolean,
    onEvent: (event: AgentControlProcessEvent) => void,
  ): Promise<{ process: AgentControlProcess; sandboxMode: CodexSandboxMode }> {
    const channel = new Channel<AgentControlProcessEvent>()
    channel.onmessage = onEvent
    const started = await invoke<CodexAppServerStart>('start_codex_app_server', {
      bin: bin || null,
      cwd,
      readOnly,
      onEvent: channel,
    })
    return {
      process: new AgentControlProcess(started.processId),
      sandboxMode: started.sandboxMode,
    }
  }

  static async startClaude(
    options: ClaudeControlProcessOptions,
    onEvent: (event: AgentControlProcessEvent) => void,
  ): Promise<AgentControlProcess> {
    const channel = new Channel<AgentControlProcessEvent>()
    channel.onmessage = onEvent
    const id = await invoke<string>('start_claude_control', {
      bin: options.bin || null,
      cwd: options.cwd,
      jsonSchema: options.jsonSchema == null ? null : JSON.stringify(options.jsonSchema),
      resume: options.resume || null,
      disallowedTools: options.disallowedTools ?? null,
      appendSystemPrompt: options.appendSystemPrompt || null,
      onEvent: channel,
    })
    return new AgentControlProcess(id)
  }

  write(message: unknown): Promise<void> {
    const line = typeof message === 'string' ? message : JSON.stringify(message)
    return invoke('write_agent_control', { processId: this.id, line })
  }

  stop(): Promise<void> {
    return invoke('stop_agent_control', { processId: this.id })
  }
}
