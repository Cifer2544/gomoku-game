import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ command, isPreview }) => ({
  /*
   * GitHub Pages 把站点挂在 https://<用户名>.github.io/<仓库名>/ 这个子路径下，
   * 而 Vite 默认按根路径产出 /assets/xxx.js。地址对不上，线上就是白屏 + 一堆 404。
   *
   * 所以只在构建产物（以及 preview 预览产物）里切到仓库名前缀，
   * 本地 npm run dev 仍然是根路径 —— 否则开发时要手动敲 /gomoku-game/ 才能打开。
   *
   * isPreview 必须一起算进去：preview 的命令是 serve，产物里的资源却已经带上了
   * /gomoku-game/ 前缀，若 preview 仍按根路径服务，本地预览会 404 白屏。
   * 因此用 preview 验证时地址是 http://localhost:4173/gomoku-game/。
   */
  base: command === 'build' || isPreview ? '/gomoku-game/' : '/',

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
}))
