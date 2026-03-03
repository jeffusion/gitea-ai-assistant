import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      // 将 /admin/api 的请求代理到后端服务
      '/admin/api': {
        target: 'http://localhost:5174', // 后端服务地址
        changeOrigin: true,
      },
    },
  },
})
