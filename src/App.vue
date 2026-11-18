<script setup lang="ts">
/**
 * 应用根组件 —— 只承担"壳子"职责。
 * ------------------------------------------------------------------
 * 这里不写任何业务逻辑：
 * - 棋盘、竞技场等具体功能，以组件形式挂载到 .app__main 中；
 * - 布局与视图切换统一交给本文件，子组件只关心自己的内容。
 *
 * 视图切换策略：
 * - 对局页用 v-show 保留，切到竞技场再切回来时棋局不会被重置；
 * - 竞技场用 v-if，切走即卸载，组件在 onBeforeUnmount 里会顺手停掉自动对弈，
 *   避免看不见的标签页在后台持续跑搜索把 CPU 占住。
 */

import { ref } from 'vue'
import AiBattle from './components/AiBattle.vue'
import GameBoard from './components/GameBoard.vue'

type TabId = 'play' | 'battle'

interface TabItem {
  id: TabId
  label: string
  hint: string
}

const TABS: readonly TabItem[] = [
  { id: 'play', label: '玩家对战', hint: '人机 / 双人' },
  { id: 'battle', label: 'AI 竞技场', hint: '双引擎对弈' },
]

const activeTab = ref<TabId>('play')
</script>

<template>
  <div class="app">
    <header class="app__header">
      <h1 class="app__title">五子棋</h1>
      <p class="app__subtitle">Gomoku · 15 × 15</p>
    </header>

    <nav class="app__tabs" role="tablist" aria-label="功能切换">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        role="tab"
        class="app__tab"
        :class="{ 'app__tab--active': activeTab === tab.id }"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
        <span class="app__tab-hint">{{ tab.hint }}</span>
      </button>
    </nav>

    <main class="app__main">
      <GameBoard v-show="activeTab === 'play'" />
      <AiBattle v-if="activeTab === 'battle'" />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  min-height: 100%;
  padding: 32px 16px;
}

.app__header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding-top: 4px;
  text-align: center;
}

.app__title {
  margin: 0;
  /* 字号随视口收缩，窄屏不会被撑破，宽屏也不会失控放大 */
  font-size: clamp(28px, 6.6vw, 38px);
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: clamp(2px, 1.2vw, 7px);
  /* 字距会在末字右侧留出等宽空白，补同宽内容边距让字形整体居中 */
  padding-left: clamp(2px, 1.2vw, 7px);
  /* 上白下青的竖向渐变，与冷调主题一致 */
  background: linear-gradient(180deg, #ffffff 0%, #dcf0ff 40%, #8ec6e6 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  /*
   * 文字被裁成透明后 text-shadow 不会生效，
   * 发光改用 filter 的 drop-shadow，作用在裁切后的字形轮廓上。
   */
  filter: drop-shadow(0 3px 18px rgba(72, 190, 226, 0.38));
}

.app__subtitle {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 3px;
  color: #8fadc9;
  text-transform: uppercase;
  text-shadow: 0 1px 12px rgba(60, 170, 210, 0.28);
}

/* 副标题两侧的渐隐细线，替代孤零零一行小字 */
.app__subtitle::before,
.app__subtitle::after {
  content: '';
  width: 30px;
  height: 1px;
}

.app__subtitle::before {
  background: linear-gradient(90deg, transparent, rgba(124, 192, 226, 0.55));
}

.app__subtitle::after {
  background: linear-gradient(270deg, transparent, rgba(124, 192, 226, 0.55));
}

/* 窄屏下收紧字距与装饰线长度，保证标题区不溢出 */
@media (max-width: 420px) {
  .app__subtitle {
    gap: 7px;
    font-size: 10px;
    letter-spacing: 2px;
  }

  .app__subtitle::before,
  .app__subtitle::after {
    width: 18px;
  }
}

/* 视图切换：与棋盘工具条的分段按钮保持同一视觉语言 */
.app__tabs {
  display: inline-flex;
  gap: 3px;
  padding: 3px;
  border-radius: 999px;
  background: rgba(12, 22, 40, 0.62);
  backdrop-filter: blur(12px);
  box-shadow: inset 0 0 0 1px rgba(120, 175, 215, 0.18);
}

.app__tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 6px 20px;
  font-size: 13px;
  color: #93a7bf;
  background: transparent;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
}

.app__tab:hover {
  color: #e4eefc;
}

.app__tab-hint {
  font-size: 10px;
  letter-spacing: 0.5px;
  color: #5f7488;
}

.app__tab--active {
  color: #f2f9ff;
  font-weight: 500;
  background: rgba(58, 150, 180, 0.34);
  box-shadow:
    inset 0 0 0 1px rgba(110, 200, 220, 0.34),
    0 2px 10px rgba(0, 10, 24, 0.4);
}

.app__tab--active .app__tab-hint {
  color: #9ec4d4;
}

/*
 * 主区域使用 flex 布局，默认水平居中；
 * 后续把棋盘和侧边控制面板并排放入时，无需再改这里。
 */
.app__main {
  display: flex;
  flex: 1;
  justify-content: center;
  align-items: flex-start;
  gap: 32px;
  width: 100%;
}

/*
 * 矮窗口（分屏、手机横屏）：外壳整体收紧。
 * 标题区和大间距在黑盘时占掉一百多像素，用户一进页就要滚很久才看得到棋盘。
 */
@media (max-height: 720px) {
  .app {
    gap: 12px;
    padding: 16px;
  }

  .app__header {
    gap: 8px;
    padding-top: 0;
  }

  .app__title {
    font-size: clamp(24px, 5vw, 30px);
  }
}
</style>
