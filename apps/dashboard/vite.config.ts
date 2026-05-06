import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    host: true,
    proxy: {
      // shujian-agent (Rust runtime)
      '/api': {
        target: 'http://localhost:8002',
        changeOrigin: true,
      },
      // cursor-bridge (Node + @cursor/sdk)
      '/cursor': {
        target: 'http://localhost:8003',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/cursor/, ''),
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  // Pre-bundle the heavy lazy-loaded deps so the first dynamic `import()`
  // doesn't fail with "Failed to fetch dynamically imported module".
  optimizeDeps: {
    include: ['mermaid', 'shiki'],
  },
})
