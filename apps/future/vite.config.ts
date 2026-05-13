import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5274,
    host: true,
    proxy: {
      // shujian-backend (Rust + Axum) — owns business data going forward.
      // The frontend calls /backend/v1/future/state etc. (see lib/backend.ts);
      // in dev that gets proxied here, in prod it goes straight to Railway.
      // Override target with BACKEND_DEV_TARGET=http://localhost:8080 when
      // actively hacking on the backend.
      '/backend': {
        target:
          process.env.BACKEND_DEV_TARGET ??
          'https://backend-production-fb29.up.railway.app',
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
})
