import { Channel, invoke } from '@tauri-apps/api/core'

/**
 * Bridge to the local Claude Code engine. FlowM spawns the user's installed `claude`
 * CLI (Tauri/Rust `claude_run`) in a project directory and streams its output back -
 * the first step toward "drawing -> Claude builds the project locally". Auth is the
 * user's own `claude auth login` (subscription); FlowM passes no key.
 *
 * Desktop (Tauri) only - there is no local CLI to spawn in a browser.
 */
export type ClaudeEvent =
  | { kind: 'stdout'; line: string }
  | { kind: 'stderr'; line: string }
  | { kind: 'exit'; code: number | null }

/**
 * Run `claude -p <prompt>` (headless stream-json) in `cwd`, calling `onEvent` for each
 * streamed line and the final exit. `bin` overrides the executable (e.g. a full path to
 * claude.exe on Windows npm installs). When `jsonSchema` is given, it's passed to
 * `--json-schema` so Claude's final answer is a validated object (draw mode reads it from
 * the `result` event's `structured_output`). `appendSystemPrompt` is passed per invocation
 * instead of writing shared project memory files.
 */
export async function claudeRun(
  prompt: string,
  cwd: string,
  onEvent: (e: ClaudeEvent) => void,
  bin?: string,
  jsonSchema?: unknown,
  resume?: string,
  disallowedTools?: string[],
  appendSystemPrompt?: string,
): Promise<void> {
  const channel = new Channel<ClaudeEvent>()
  channel.onmessage = onEvent
  await invoke('claude_run', {
    prompt,
    cwd,
    bin: bin ?? null,
    // The CLI takes the schema as a JSON string arg; serialize here (Rust forwards it verbatim).
    jsonSchema: jsonSchema != null ? JSON.stringify(jsonSchema) : null,
    // Session continuity: resume a prior Claude Code session (--resume) so history lives in
    // Claude Code's session, and this prompt is just the delta.
    resume: resume ?? null,
    // Tools to forbid (--disallowedTools), e.g. the canvas engine forbids `Task` so the model
    // reads code directly instead of spawning a costly, stream-perturbing subagent.
    disallowedTools: disallowedTools ?? null,
    appendSystemPrompt: appendSystemPrompt ?? null,
    onEvent: channel,
  })
}

/** The platform's conventional `claude` path (the Rust backend probes common install locations),
 *  used to prefill the editable binary-path field. A packaged Mac app launched from Finder doesn't
 *  inherit the shell PATH, so an absolute path here is what lets `claude` spawn. */
export async function defaultClaudeBin(): Promise<string> {
  return invoke<string>('default_claude_bin')
}

/** Write the canvas PNG (data URL) to `<cwd>/.flowm/design.png` so the spawned `claude`
 *  can Read it. Returns the relative path to reference in the prompt. */
export async function writeDesign(cwd: string, dataUrl: string): Promise<string> {
  return invoke<string>('write_design', { cwd, dataUrl })
}
