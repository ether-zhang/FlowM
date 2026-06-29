import { Channel, invoke } from '@tauri-apps/api/core'

/**
 * Bridge to the local Claude Code engine. FlowM spawns the user's installed `claude`
 * CLI (Tauri/Rust `claude_run`) in a project directory and streams its output back —
 * the first step toward "drawing → Claude builds the project locally". Auth is the
 * user's own `claude auth login` (subscription); FlowM passes no key.
 *
 * Desktop (Tauri) only — there is no local CLI to spawn in a browser.
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
 * the `result` event's `structured_output`). Resolves when the process exits.
 */
export async function claudeRun(
  prompt: string,
  cwd: string,
  onEvent: (e: ClaudeEvent) => void,
  bin?: string,
  jsonSchema?: unknown,
  resume?: string,
  disallowedTools?: string[],
): Promise<void> {
  const channel = new Channel<ClaudeEvent>()
  channel.onmessage = onEvent
  await invoke('claude_run', {
    prompt,
    cwd,
    bin: bin ?? null,
    // The CLI takes the schema as a JSON string arg; serialize here (Rust forwards it verbatim).
    jsonSchema: jsonSchema != null ? JSON.stringify(jsonSchema) : null,
    // Session continuity: resume a prior Claude Code session (--resume) so the project guide
    // (CLAUDE.local.md) + history live in Claude Code's session (cached), and this prompt is
    // just the delta — FlowM never replays prior turns.
    resume: resume ?? null,
    // Tools to forbid (--disallowedTools), e.g. the canvas engine forbids `Task` so the model
    // reads code directly instead of spawning a costly, stream-perturbing subagent.
    disallowedTools: disallowedTools ?? null,
    onEvent: channel,
  })
}


/** Write the canvas PNG (data URL) to `<cwd>/.flowm/design.png` so the spawned `claude`
 *  can Read it. Returns the relative path to reference in the prompt. */
export async function writeDesign(cwd: string, dataUrl: string): Promise<string> {
  return invoke<string>('write_design', { cwd, dataUrl })
}

/** Write FlowM's drawing guide to `<cwd>/CLAUDE.local.md` — the project "switch" Claude Code
 *  auto-loads on every invocation (and prompt-caches across `--resume`). FlowM owns this file;
 *  CLAUDE.local.md is conventionally gitignored, so it doesn't pollute the user's tracked repo. */
export async function writeGuide(cwd: string, content: string): Promise<void> {
  await invoke('write_guide', { cwd, content })
}
