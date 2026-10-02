import { Channel, invoke } from '@tauri-apps/api/core'
import type { HarnessProcessEvent, HarnessTransport } from './types'

/** Only Tauri's packaged resource resolver can choose an executable; no renderer path setting. */
export async function startHarness(onEvent: (event: HarnessProcessEvent) => void): Promise<HarnessTransport> {
  const channel = new Channel<HarnessProcessEvent>()
  channel.onmessage = onEvent
  const processId = await invoke<string>('start_flowm_harness', { onEvent: channel })
  return {
    write: (message) => invoke('write_flowm_harness', { processId, line: JSON.stringify(message) }),
    stop: () => invoke('stop_flowm_harness', { processId }),
  }
}
