import { isTauri } from '@tauri-apps/api/core'

/**
 * True when running inside the Tauri desktop shell (vs a plain browser).
 * In the browser this is simply false and no Tauri APIs are ever called.
 */
export const IS_TAURI = isTauri()
