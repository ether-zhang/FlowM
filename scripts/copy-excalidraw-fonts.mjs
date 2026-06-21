// Copy Excalidraw's runtime fonts into public/ so the packaged (offline) Tauri
// build can load the canvas fonts (Excalifont, Nunito, Xiaolai/CJK, …) instead
// of falling back to a system font. Excalidraw fetches these at runtime from
// `${window.EXCALIDRAW_ASSET_PATH}fonts/…` (set to "/" in index.html), which maps
// to dist/fonts after the build. The UI font (Assistant) is already bundled via
// CSS; this covers the rest. Output is gitignored and regenerated each build.
import { cpSync, existsSync, rmSync } from 'node:fs'

const src = 'node_modules/@excalidraw/excalidraw/dist/prod/fonts'
const dest = 'public/fonts'

if (!existsSync(src)) {
  console.error(`[fonts] source not found: ${src} — is @excalidraw/excalidraw installed?`)
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
cpSync(src, dest, { recursive: true })
console.log(`[fonts] copied Excalidraw fonts → ${dest}`)
