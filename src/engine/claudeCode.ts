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
 * claude.exe on Windows npm installs). Resolves when the process exits.
 */
export async function claudeRun(
  prompt: string,
  cwd: string,
  onEvent: (e: ClaudeEvent) => void,
  bin?: string,
): Promise<void> {
  const channel = new Channel<ClaudeEvent>()
  channel.onmessage = onEvent
  await invoke('claude_run', { prompt, cwd, bin: bin ?? null, onEvent: channel })
}
