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
      // shujian-backend (Rust + Axum, tenants & auth).
      // Default target is the Railway prod deployment so the dashboard
      // works out of the box without running the backend locally.
      // Override with BACKEND_DEV_TARGET=http://localhost:8080 when actively
      // hacking on the backend.
      '/backend': {
        target: process.env.BACKEND_DEV_TARGET ?? 'https://backend-production-fb29.up.railway.app',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/backend/, ''),
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    include: ['mermaid', 'shiki'],
  },
})
