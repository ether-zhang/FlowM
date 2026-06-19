import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
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
