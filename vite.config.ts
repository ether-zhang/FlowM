import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri spawns this dev server (beforeDevCommand) and points its webview at it;
  // keep the port fixed and don't let Vite clear Tauri's console output.
  clearScreen: false,
  server: {
    strictPort: true,
    // Don't let Vite's file watcher into the Rust build dir: `cargo build` churns
    // thousands of files in src-tauri/target and locks .pdb files, which crashes
    // the watcher with EBUSY and kills the dev server.
    watch: { ignored: ['**/src-tauri/**'] },
    // Poe's API does not allow browser CORS. In dev we proxy through the Vite
    // server (server-side request → no CORS). The OpenAI client points at the
    // same-origin "/poe/v1" path (see src/llm/poe.ts). For production/Tauri the
    // call should instead go through a Rust command (plan, step 8).
    proxy: {
      '/poe': {
        target: 'https://api.poe.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/poe/, ''),
      },
    },
  },
})
