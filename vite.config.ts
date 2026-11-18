import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],

  server: {
    // host: true 等价于 --host，让 Vite 监听 0.0.0.0。
    // 不写这项时 Vite 只监听 localhost，手机即使敲门也进不来。
    host: true,
    port: 5173,
  },

  preview: {
    // npm run preview 出来的产物同样允许手机访问
    host: true,
    port: 4173,
  },
})
