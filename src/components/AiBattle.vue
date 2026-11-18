<script setup lang="ts">
/**
 * AI 竞技场 AiBattle
 * ------------------------------------------------------------------
 * 职责：让两个算法完全不同的引擎自动对弈，并把胜负统计持久化到 localStorage。
 *
 * 两个参赛者：
 * - 极简版（simpleEngine）：单点棋型评估 + 固定深度 alpha-beta；
 * - Qoder 版（qoderEngine）：增量窗口评估 + PVS + 迭代加深 + VCF。
 *
 * 设计要点：
 * 1. 严格交替先手：五子棋先手优势极大，若固定某一方执黑，统计会系统性偏移；
 * 2. 每步用 setTimeout 让出主线程，否则连续同步搜索会让页面看起来卡死；
 * 3. 引擎返回非法坐标时直接判负，而不是让对局死循环；
 * 4. 组件卸载（切到别的标签页）时立刻停止对局，避免后台空转 CPU。
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getQoderBestMove, QODER_BATTLE_TIME_MS } from '../logic/ai/qoderEngine'
import { getSimpleBestMove } from '../logic/ai/simpleEngine'
import { checkWin, createEmptyBoard, isInsideBoard } from '../logic/rules'
import type { Board, Player, Position } from '../logic/types'
import { INDEXES, STAR_POINTS } from './boardLayout'

type EngineId = 'simple' | 'qoder'

const ENGINE_LABEL: Record<EngineId, string> = {
  simple: '极简防守反击',
  qoder: 'Qoder 高级引擎',
}

const STORAGE_KEY = 'gomoku_ai_battle_stats'

/** 每手之间的停顿，让观战者能看清落子顺序 */
const STEP_DELAY_MS = 60

/**
 * 单局手数上限。
 *
 * 到上限仍未分胜负直接判平局。这是竞技场自己的规则，不是五子棋规则，
 * GameBoard 里的实战对局不受它约束。
 *
 * 之所以需要它：两个引擎水平接近时会长时间互相试探，实测出现过 122 手
 * 还在磨的局，棋盘填掉一半仍无结果，观战体验很差。
 */
const MAX_MOVES = 120

interface BattleStats {
  simpleWins: number
  qoderWins: number
  draws: number
  total: number
}

/* ------------------------------ 状态 ------------------------------ */

const board = ref<Board>(createEmptyBoard())
const isPlaying = ref(false)
const moveCount = ref(0)
const lastMove = ref<Position | null>(null)
const outcome = ref('点击「开始新对局」观战')
const stats = ref<BattleStats>({ simpleWins: 0, qoderWins: 0, draws: 0, total: 0 })

/** 本局极简版执哪一色；由已完成局数的奇偶决定，保证先手机会均等 */
const simpleColor = ref<Player>('black')

/** 当前该落子的一方，决定幽灵棋子的颜色；与对局循环里的 turn 保持同步 */
const currentTurn = ref<Player>('black')

/** 鼠标悬浮的交叉点，用于渲染幽灵棋子 */
const hoverPosition = ref<Position | null>(null)

/**
 * 对局令牌：每次开始 / 停止都自增。
 * 循环体在每个 await 之后比对令牌，不一致就立即退出，
 * 避免"停止后又落一手"或两次对局互相穿插。
 */
let runToken = 0

/** 用户主动停止的标记，与"正常分出胜负"区分开 */
let aborted = false

/* ------------------------------ 派生状态 ------------------------------ */

/**
 * 有效对局数：总场次去掉平局。
 *
 * 胜率只在"分出胜负"的局里算 —— 平局（包括 120 手上限判平）不能说明任何一方更强，
 * 若把它算进分母，两个引擎的胜率会被一起稀释，看起来像"都不行"。
 */
const decidedGames = computed(() => Math.max(0, stats.value.total - stats.value.draws))

/** 某方胜率：该方胜场 / 有效对局数。有效对局为 0 时返回 0，避免出现 NaN */
function winRate(wins: number): number {
  return decidedGames.value === 0 ? 0 : Math.round((wins / decidedGames.value) * 100)
}

const simpleRate = computed(() => winRate(stats.value.simpleWins))
const qoderRate = computed(() => winRate(stats.value.qoderWins))

const progressText = computed(() => `第 ${moveCount.value} 手 / 最多 ${MAX_MOVES} 手`)

/**
 * 幽灵棋子位置。
 * 三个条件：有悬浮点、对局进行中、该点为空。
 * 开始前和结束后悬停都没有"落子"含义，所以不显示。
 */
const ghostPosition = computed<Position | null>(() => {
  const position = hoverPosition.value
  if (!position) return null
  if (!isPlaying.value) return null
  return board.value[position.y][position.x] === 'empty' ? position : null
})

/* ------------------------------ 统计持久化 ------------------------------ */

function loadStats(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<BattleStats>
    stats.value = {
      simpleWins: Number(parsed.simpleWins) || 0,
      qoderWins: Number(parsed.qoderWins) || 0,
      draws: Number(parsed.draws) || 0,
      total: Number(parsed.total) || 0,
    }
  } catch (error) {
    // 数据损坏时直接丢弃，不影响对局功能
    console.warn('[AI 竞技场] 读取统计数据失败：', error)
  }
}

function saveStats(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats.value))
  } catch (error) {
    console.warn('[AI 竞技场] 保存统计数据失败：', error)
  }
}

function resetStats(): void {
  if (isPlaying.value) return
  stats.value = { simpleWins: 0, qoderWins: 0, draws: 0, total: 0 }
  saveStats()
  outcome.value = '统计数据已清空'
}

/* ------------------------------ 对局控制 ------------------------------ */

function stopGame(): void {
  if (!isPlaying.value) return
  aborted = true
  isPlaying.value = false
  runToken += 1
  outcome.value = '已手动停止'
}

/** 记录一局结果并落盘 */
function recordWin(winner: EngineId): void {
  const next = { ...stats.value, total: stats.value.total + 1 }
  if (winner === 'simple') next.simpleWins += 1
  else next.qoderWins += 1
  stats.value = next
  saveStats()
}

function recordDraw(): void {
  stats.value = { ...stats.value, draws: stats.value.draws + 1, total: stats.value.total + 1 }
  saveStats()
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

/** 让浏览器有机会把上一手渲染出来，再开始同步搜索 */
function yieldToPaint(): Promise<void> {
  return sleep(0)
}

/**
 * 跑完整一局。
 *
 * 循环不变量：`turn` 永远是当前该落子的一方；
 * 每次 await 之后都检查 `aborted` 与 `runToken`，确保停止按钮能立刻生效。
 */
async function startGame(): Promise<void> {
  if (isPlaying.value) return

  const token = ++runToken
  aborted = false
  isPlaying.value = true
  board.value = createEmptyBoard()
  moveCount.value = 0
  lastMove.value = null
  outcome.value = 'AI 正在对局…'

  // 交替先手：total 为偶数时极简版执黑，奇数时执白
  simpleColor.value = stats.value.total % 2 === 0 ? 'black' : 'white'

  // 黑棋固定先手，幽灵棋子的颜色从黑开始
  currentTurn.value = 'black'

  await yieldToPaint()
  if (aborted || token !== runToken) return

  let turn: Player = 'black'

  while (token === runToken) {
    const engine: EngineId = turn === simpleColor.value ? 'simple' : 'qoder'

    let move: Position
    try {
      move =
        engine === 'simple'
          ? getSimpleBestMove(board.value, turn)
          : getQoderBestMove(board.value, turn, QODER_BATTLE_TIME_MS)
    } catch (error) {
      console.error('[AI 竞技场] 引擎计算失败：', error)
      outcome.value = `${ENGINE_LABEL[engine]} 计算异常：${(error as Error).message}`
      isPlaying.value = false
      return
    }

    // 停止指令可能在同步搜索期间被点下
    if (aborted || token !== runToken) return

    // 非法着法直接判负，避免同一方被反复要求落子导致死循环
    if (!isInsideBoard(move) || board.value[move.y][move.x] !== 'empty') {
      const loser = engine
      const winner: EngineId = loser === 'simple' ? 'qoder' : 'simple'
      recordWin(winner)
      outcome.value = `${ENGINE_LABEL[loser]} 返回非法着法 (${move.x}, ${move.y})，判负`
      isPlaying.value = false
      return
    }

    board.value[move.y][move.x] = turn
    lastMove.value = move
    moveCount.value += 1

    if (checkWin(board.value, move, turn)) {
      const winner: EngineId = turn === simpleColor.value ? 'simple' : 'qoder'
      recordWin(winner)
      outcome.value = `${ENGINE_LABEL[winner]} 获胜（第 ${moveCount.value} 手）`
      isPlaying.value = false
      return
    }

    // 竞技场规则：到 120 手仍未分胜负直接判平局，避免长时间磨棋盘
    if (moveCount.value >= MAX_MOVES) {
      recordDraw()
      outcome.value = `达到 ${MAX_MOVES} 手上限，判为平局`
      isPlaying.value = false
      return
    }

    turn = turn === 'black' ? 'white' : 'black'
    currentTurn.value = turn
    await sleep(STEP_DELAY_MS)
    if (aborted || token !== runToken) return
  }
}

/* ------------------------------ 悬浮预览 ------------------------------ */

/**
 * 指针进入交叉点。
 *
 * 用 pointerenter 而不是 mouseenter：触屏上 tap 会合成一次 mouseenter，
 * 却不会有对应的 mouseleave，幽灵棋子会一直粘在屏幕上。
 * pointerenter 带 pointerType，触摸事件直接忽略，鼠标和笔保留。
 */
function handlePointEnter(position: Position, event: PointerEvent): void {
  if (event.pointerType === 'touch') return
  hoverPosition.value = position
}

/** 指针离开交叉点：只有离开的正是当前悬浮点才清除，避免相邻点之间来回抖动 */
function handlePointLeave(position: Position, event: PointerEvent): void {
  if (event.pointerType === 'touch') return
  const current = hoverPosition.value
  if (current && current.x === position.x && current.y === position.y) {
    hoverPosition.value = null
  }
}

/* ------------------------------ 渲染辅助 ------------------------------ */

function isLastMove(position: Position): boolean {
  return lastMove.value?.x === position.x && lastMove.value?.y === position.y
}

/** 交叉点的绝对定位：第 (index + 0.5) 个格子的中心 */
function positionStyle(position: Position): Record<string, string> {
  return {
    left: `calc(${position.x + 0.5} * var(--cell))`,
    top: `calc(${position.y + 0.5} * var(--cell))`,
  }
}

/* ------------------------------ 生命周期 ------------------------------ */

onMounted(loadStats)

onBeforeUnmount(() => {
  // 切到别的标签页就停止，不让对局在后台继续吃 CPU
  aborted = true
  isPlaying.value = false
  runToken += 1
})
</script>

<template>
  <div class="battle">
    <!-- 记分板 -->
    <section class="panel" aria-label="对局统计">
      <h2 class="panel__title">AI 对局统计</h2>

      <div class="scoreboard">
        <div class="scoreboard__side">
          <span class="scoreboard__dot" :class="`scoreboard__dot--${simpleColor === 'black' ? 'black' : 'white'}`"></span>
          <p class="scoreboard__name">{{ ENGINE_LABEL.simple }}</p>
          <p class="scoreboard__value">{{ stats.simpleWins }}</p>
          <p class="scoreboard__rate" title="平局不计入分母">胜率 {{ simpleRate }}%</p>
        </div>

        <span class="scoreboard__vs">VS</span>

        <div class="scoreboard__side">
          <span class="scoreboard__dot" :class="`scoreboard__dot--${simpleColor === 'black' ? 'white' : 'black'}`"></span>
          <p class="scoreboard__name">{{ ENGINE_LABEL.qoder }}</p>
          <p class="scoreboard__value">{{ stats.qoderWins }}</p>
          <p class="scoreboard__rate" title="平局不计入分母">胜率 {{ qoderRate }}%</p>
        </div>
      </div>

      <p class="panel__meta">
        共 {{ stats.total }} 局 · 平局 {{ stats.draws }} 局 · 有效 {{ decidedGames }} 局 · 本局极简版执{{
          simpleColor === 'black' ? '黑先手' : '白后手'
        }}
      </p>
      <p class="panel__status" role="status">{{ outcome }}</p>
      <p class="panel__progress">{{ progressText }}</p>
    </section>

    <!-- 操作区 -->
    <div class="controls">
      <button type="button" class="btn btn--primary" :disabled="isPlaying" @click="startGame">
        {{ isPlaying ? '对局进行中…' : '开始新对局' }}
      </button>
      <button type="button" class="btn" :disabled="!isPlaying" @click="stopGame">停止</button>
      <button type="button" class="btn" :disabled="isPlaying" @click="resetStats">清空统计</button>
    </div>

    <!-- 棋盘：只渲染，不接受交互 -->
    <div class="board" :class="{ 'board--playing': isPlaying }">
      <div class="board__stars" aria-hidden="true">
        <span
          v-for="star in STAR_POINTS"
          :key="`star-${star.x}-${star.y}`"
          class="star"
          :style="positionStyle(star)"
        ></span>
      </div>

      <div class="board__grid">
        <template v-for="y in INDEXES" :key="`row-${y}`">
          <div
            v-for="x in INDEXES"
            :key="`${x}-${y}`"
            class="point"
            @pointerenter="handlePointEnter({ x, y }, $event)"
            @pointerleave="handlePointLeave({ x, y }, $event)"
          >
            <span
              v-if="board[y][x] !== 'empty'"
              class="stone"
              :class="`stone--${board[y][x]}`"
            >
              <span v-if="isLastMove({ x, y })" class="stone__marker"></span>
            </span>
          </div>
        </template>

        <!--
          幽灵棋子：整个棋盘只渲染一个节点，用绝对定位跟随悬浮交叉点，
          颜色取当前该落子的一方。
          pointer-events: none 是关键——它不能拦住下方交叉点的鼠标事件。
        -->
        <Transition name="ghost-fade">
          <span
            v-if="ghostPosition"
            class="ghost"
            :class="`ghost--${currentTurn}`"
            :style="positionStyle(ghostPosition)"
            aria-hidden="true"
          ></span>
        </Transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
.battle {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

/* ------------------------------ 统计面板 ------------------------------ */

.panel {
  width: min(100%, 460px);
  padding: 18px 20px 14px;
  border-radius: 14px;
  /* 与对局面板同一套玻璃卡片配方，两个页签的质感保持一致 */
  background: rgba(13, 23, 41, 0.66);
  backdrop-filter: blur(14px) saturate(1.15);
  box-shadow:
    inset 0 0 0 1px rgba(120, 175, 215, 0.16),
    0 12px 30px rgba(0, 8, 20, 0.45);
  text-align: center;
}

.panel__title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 1px;
  color: #dbe7f6;
}

.scoreboard {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 14px;
}

.scoreboard__side {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.scoreboard__dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.scoreboard__dot--black {
  background: radial-gradient(circle at 32% 28%, #7c8794, #111111 72%);
  /* 暗色面板上纯黑会失去轮廓，描一圈冷色边 */
  box-shadow: 0 0 0 1px rgba(150, 190, 220, 0.45);
}

.scoreboard__dot--white {
  background: radial-gradient(circle at 32% 28%, #ffffff, #cfcfcf 78%);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}

.scoreboard__name {
  font-size: 12px;
  color: #8fa4bd;
}

.scoreboard__value {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
  color: #eef5ff;
  font-variant-numeric: tabular-nums;
}

.scoreboard__rate {
  font-size: 12px;
  color: #7f93ad;
}

.scoreboard__vs {
  flex: none;
  font-size: 13px;
  font-weight: 700;
  font-style: italic;
  color: #3f5670;
}

.panel__meta {
  margin-top: 12px;
  font-size: 12px;
  color: #8195ae;
}

.panel__status {
  margin-top: 6px;
  font-size: 14px;
  font-weight: 500;
  /* 用背景图里的青绿做强调色，比暖橙更贴合冷调主题 */
  color: #4fc3d8;
}

.panel__progress {
  margin-top: 2px;
  font-size: 12px;
  color: #5e7288;
}

/* ------------------------------ 操作按钮 ------------------------------ */

.controls {
  display: flex;
  gap: 10px;
}

.btn {
  padding: 8px 18px;
  font-size: 13px;
  color: #b9c9dd;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(140, 180, 215, 0.22);
  border-radius: 999px;
  cursor: pointer;
  transition: color 0.2s, border-color 0.2s, background 0.2s;
}

.btn:hover:not(:disabled) {
  color: #eaf3ff;
  background: rgba(90, 180, 210, 0.18);
  border-color: rgba(140, 205, 230, 0.42);
}

.btn:disabled {
  color: rgba(150, 170, 195, 0.38);
  cursor: not-allowed;
}

.btn--primary {
  color: #ffffff;
  background: #1f7f96;
  border-color: #1f7f96;
  box-shadow: 0 4px 14px rgba(31, 127, 150, 0.45);
}

.btn--primary:hover:not(:disabled) {
  color: #ffffff;
  background: #176a7e;
  border-color: #176a7e;
}

.btn--primary:disabled {
  color: rgba(220, 235, 250, 0.55);
  background: #2b4457;
  border-color: #2b4457;
  box-shadow: none;
}

/* ------------------------------ 棋盘 ------------------------------ */

.board {
  --cell: clamp(16px, 2.4vw, 26px);
  /* 与对局页同一块冷调石板，两个页签的棋盘必须长得一样 */
  --board-light: #2b3a56;
  --board-dark: #1a2438;
  --line-color: rgba(150, 200, 230, 0.32);

  position: relative;
  padding: 10px;
  border-radius: 10px;
  background-color: var(--board-light);
  background-image:
    repeating-linear-gradient(0deg, rgba(170, 210, 240, 0.014) 0 1px, transparent 1px 5px),
    repeating-linear-gradient(90deg, rgba(0, 0, 0, 0.03) 0 1px, transparent 1px 7px),
    linear-gradient(
      115deg,
      transparent 0%,
      rgba(150, 190, 230, 0.035) 18%,
      transparent 34%,
      rgba(0, 0, 0, 0.05) 52%,
      transparent 68%
    ),
    radial-gradient(circle at 30% 16%, var(--board-light), var(--board-dark) 78%);
  box-shadow:
    0 22px 46px rgba(0, 6, 18, 0.66),
    0 0 0 1px rgba(120, 200, 225, 0.22),
    0 0 64px rgba(56, 180, 210, 0.16),
    inset 0 0 0 1px rgba(190, 220, 245, 0.14),
    inset 0 0 40px rgba(0, 10, 25, 0.55);
  user-select: none;
}

.board__stars {
  position: absolute;
  inset: 10px;
  pointer-events: none;
}

.star {
  position: absolute;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  background: rgba(130, 205, 230, 0.68);
  box-shadow: 0 0 6px rgba(90, 200, 230, 0.55);
}

.board__grid {
  position: relative;
  display: grid;
  grid-template-columns: repeat(15, var(--cell));
  grid-template-rows: repeat(15, var(--cell));
  background-image:
    repeating-linear-gradient(to right, var(--line-color) 0 1px, transparent 1px var(--cell)),
    repeating-linear-gradient(to bottom, var(--line-color) 0 1px, transparent 1px var(--cell));
  background-position:
    calc(var(--cell) / 2) 0,
    0 calc(var(--cell) / 2);
}

.point {
  position: relative;
  display: grid;
  place-items: center;
}

/* ------------------------------ 棋子 ------------------------------ */

.stone {
  position: relative;
  z-index: 1;
  width: 86%;
  height: 86%;
  border-radius: 50%;
  animation: stone-drop 0.16s ease-out;
}

.stone--black {
  /* 深蓝底上纯黑会隐入底座，提亮中心 + 补冷色描边 */
  background: radial-gradient(circle at 32% 26%, #6f839c 0%, #232e3f 30%, #0b1019 72%);
  box-shadow:
    0 3px 7px rgba(0, 0, 0, 0.55),
    0 0 0 1px rgba(150, 200, 235, 0.32),
    inset -2px -3px 6px rgba(0, 0, 0, 0.55),
    inset 2px 2px 6px rgba(170, 210, 240, 0.2);
}

.stone--white {
  background: radial-gradient(circle at 32% 26%, #ffffff 0%, #eef3fa 44%, #c3cfdd 82%);
  box-shadow:
    0 3px 7px rgba(0, 0, 0, 0.42),
    inset -2px -3px 6px rgba(40, 62, 90, 0.2),
    inset 2px 2px 5px rgba(255, 255, 255, 0.95);
}

/* 最近一手标记 */
.stone__marker {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 22%;
  height: 22%;
  border-radius: 50%;
  background: #f24a63;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.65),
    0 0 8px rgba(242, 74, 99, 0.6);
}

/* ------------------------------ 幽灵棋子 ------------------------------ */

/*
 * 与 GameBoard 的幽灵子保持同一套尺寸与配色，只是父容器不是按钮而是 grid，
 * 所以用 position: absolute + translate 居中，宽度按 --cell 折算。
 */
.ghost {
  position: absolute;
  z-index: 2;
  width: calc(var(--cell) * 0.86);
  height: calc(var(--cell) * 0.86);
  transform: translate(-50%, -50%);
  border-radius: 50%;
  opacity: 0.5;
  pointer-events: none;
}

.ghost--black {
  background: radial-gradient(circle at 32% 26%, #8ea2ba, #1b2433 72%);
  box-shadow: 0 0 0 1px rgba(160, 200, 235, 0.3);
}

.ghost--white {
  background: radial-gradient(circle at 32% 26%, #ffffff, #c3cfdd 78%);
  box-shadow: inset 0 0 0 1px rgba(30, 50, 78, 0.14);
}

/* 淡入淡出：只动 opacity，不触发重排 */
.ghost-fade-enter-active,
.ghost-fade-leave-active {
  transition: opacity 0.18s ease;
}

.ghost-fade-enter-from,
.ghost-fade-leave-to {
  opacity: 0;
}

@keyframes stone-drop {
  from {
    transform: scale(0.72);
    opacity: 0.5;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

@media (max-width: 480px) {
  .board {
    padding: 6px;
  }

  .board__stars {
    inset: 6px;
  }

  .scoreboard__value {
    font-size: 24px;
  }
}
</style>
