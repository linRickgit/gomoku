import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ command }) => ({
  // 生产构建产物挂在反向代理的 /gomoku 路径下，故静态资源基址设为 /gomoku/
  // 开发服务器仍用根路径 /，避免影响本地调试
  base: command === 'build' ? '/gomoku/' : '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 构建产物最终会被复制进 Spring Boot 的 static 目录
    assetsDir: 'assets',
  },
}))
