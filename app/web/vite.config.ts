import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 开发时把 /api 与 /uploads 代理到后端，这样前端始终用同源相对路径请求，
// 生产环境由 Hono 直接托管 dist，两边路径行为完全一致 —— 不需要任何环境变量切换。
const BACKEND = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:9200'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/uploads': { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
})
