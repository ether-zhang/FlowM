import { isTauri } from '@tauri-apps/api/core'

/**
 * Only the desktop shell may mount the application and start its native runtime.
 */
export const IS_TAURI = isTauri()
