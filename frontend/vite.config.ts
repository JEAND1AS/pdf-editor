import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000', changeOrigin: true },
      '/health': { target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
})
