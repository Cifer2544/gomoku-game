<script setup lang="ts">
/**
 * 棋盘组件 GameBoard
 * ------------------------------------------------------------------
 * 职责：
 * 1. 维护棋局状态（棋盘、当前玩家、胜负、手数、对局模式）；
 * 2. 把 15 × 15 的交叉点渲染成可点击的按钮，棋子落在交叉点上；
 * 3. 落子后调用 logic/rules.ts 的 checkWin 判断胜负，并在结束后锁定棋盘；
 * 4. 人机模式下轮到白棋时调用 logic/ai 的 getBestMove 自动落子。
 *
 * 设计要点：
 * - 组件不实现规则与 AI，只做"状态 + 交互 + 渲染"，规则/搜索全部来自 logic；
 * - 棋盘线用 CSS 渐变绘制，每个交叉点只是一个透明按钮；
 * - AI 计算是同步 CPU 任务，用自增令牌 aiTaskId 实现"重开 / 切模式即作废"，
 *   防止上一局的异步回调把棋子落到新一局里。
 */

import { computed, ref } from 'vue'
import { getBestMove } from '../logic/ai'
import { BOARD_SIZE, checkWin, createEmptyBoard, isInsideBoard } from '../logic/rules'
import type { Board, Player, Position } from '../logic/types'

/** 坐标索引集合 0 ~ 14，供模板双重循环使用（y 行 / x 列） */
const INDEXES = Array.from({ length: BOARD_SIZE }, (_, index) => index)

/** 星位（天元与四个小目），只做视觉装饰，不影响规则 */
const STAR_POINTS: readonly Position[] = [
  { x: 3, y: 3 },
  { x: 11, y: 3 },
  { x: 7, y: 7 },
  { x: 3, y: 11 },
  { x: 11, y: 11 },
]

/** 玩家中文名，用于状态栏与结算文案 */
const PLAYER_LABEL: Record<Player, string> = {
  black: '黑棋',
  white: '白棋',
}

/** 对局模式：pvp 双人对战 / pve 人机对战 */
type GameMode = 'pvp' | 'pve'

/** 玩家固定执黑先手，AI 固定执白后手 */
const HUMAN_PLAYER: Player = 'black'
const AI_PLAYER: Player = 'white'

/**
 * AI 落子前的极短等待（毫秒）。
 * 这不是"假装思考"，而是给浏览器一次渲染机会，让 isAiThinking = true
 * 真正画到屏幕上；否则同步的 AI 计算会和这次状态更新合并进同一帧，
 * 用户就看不到"思考中"这个状态。
 */
const AI_THINK_DELAY_MS = 100

/* ------------------------------ 棋局状态 ------------------------------ */

/** 一手棋的记录：落子坐标 + 落子方，悔棋时据此回滚 */
interface MoveRecord {
  position: Position
  player: Player
}

/** 当前棋盘，board[y][x]，初始为 15 × 15 全空 */
const board = ref<Board>(createEmptyBoard())

/** 当前该谁落子，黑棋默认先手 */
const currentPlayer = ref<Player>('black')

/** 胜者；null 表示尚未分出胜负 */
const winner = ref<Player | null>(null)

/** 最近一次落子位置，用于画标记点 */
const lastMove = ref<Position | null>(null)

/**
 * 落子历史（按时间顺序）。
 * 悔棋靠它回滚：坐标与落子方都在里面，不需要每次落子都快照整个棋盘。
 */
const history = ref<MoveRecord[]>([])

/**
 * 已落子数。
 * 直接由历史长度推导，而不是单独维护一个计数器——两个数一旦分开，
 * 悔棋时就容易忘了同步其中一个，进而把平局判定弄错。
 */
const moveCount = computed(() => history.value.length)

/** 当前对局模式；默认人机对战，玩家执黑先手 */
const gameMode = ref<GameMode>('pve')

/** AI 是否正在计算；为 true 时玩家点击一律忽略 */
const isAiThinking = ref(false)

/** 鼠标悬浮的交叉点，用于渲染幽灵棋子 */
const hoverPosition = ref<Position | null>(null)

/**
 * AI 异步任务令牌。
 * 每次开始 AI 回合自增，重开 / 切模式时也自增；
 * 旧任务从 await 回来发现令牌变了就直接放弃落子。
 */
let aiTaskId = 0

/** 平局：无人获胜且棋盘已被填满 */
const isDraw = computed(
  () => winner.value === null && moveCount.value === BOARD_SIZE * BOARD_SIZE,
)

/** 对局是否已结束（有人胜出或平局），用于锁定棋盘 */
const isGameOver = computed(() => winner.value !== null || isDraw.value)

/** 当前是否轮到人类操作：双人模式恒为 true，人机模式只在黑棋回合为 true */
const isHumanTurn = computed(
  () => gameMode.value === 'pvp' || currentPlayer.value === HUMAN_PLAYER,
)

/** 幽灵棋子位置：只有"人类回合 + 未结束 + 未思考 + 空点"才返回坐标 */
const ghostPosition = computed<Position | null>(() => {
  const position = hoverPosition.value
  if (!position) return null
  if (isGameOver.value || isAiThinking.value) return null
  if (!isHumanTurn.value) return null
  return board.value[position.y][position.x] === 'empty' ? position : null
})

/** 状态栏文案 */
const statusText = computed(() => {
  if (winner.value) return `${PLAYER_LABEL[winner.value]}获胜`
  if (isDraw.value) return '平局，棋盘已满'
  if (isAiThinking.value) return 'AI 思考中…'
  if (gameMode.value === 'pve') {
    return currentPlayer.value === HUMAN_PLAYER
      ? '轮到你落子（黑棋）'
      : '轮到 AI 落子（白棋）'
  }
  return `轮到${PLAYER_LABEL[currentPlayer.value]}落子`
})

/** 悔棋按钮是否可用：有落子可撤且对局未结束 */
const canUndo = computed(() => !isGameOver.value && history.value.length > 0)

/**
 * 本局一次悔棋要撤销几手。
 *
 * - 双人：只撤最近一手；
 * - 人机：末尾是玩家刚下的一手（AI 还没回应）时撤一手就够了；
 *   末尾是 AI 的回应时连它一起撤，回到玩家上次落子前的状态。
 */
const undoCount = computed(() => {
  if (!canUndo.value) return 0
  if (gameMode.value === 'pvp') return 1
  const last = history.value[history.value.length - 1]
  return last.player === HUMAN_PLAYER ? 1 : 2
})

/* ------------------------------ 交互逻辑 ------------------------------ */

/**
 * 判断某个交叉点当前是否可以落子（只管棋盘本身，不管轮到谁）。
 * 三个条件：对局未结束、坐标在盘内、该点为空。
 */
function canPlace(position: Position): boolean {
  if (isGameOver.value) return false
  if (!isInsideBoard(position)) return false
  return board.value[position.y][position.x] === 'empty'
}

/**
 * 真正落子（玩家与 AI 共用）。
 * 流程：校验 -> 写入棋盘 -> 记入历史 -> 判胜 -> 未结束则换手 -> 必要时唤醒 AI。
 *
 * @returns 是否成功落下
 */
function applyMove(position: Position): boolean {
  if (!canPlace(position)) return false

  // 先取下落子方，避免交换玩家后判胜时用错颜色
  const player = currentPlayer.value

  // 直接修改二维数组中的元素；board 是 ref，深层改动会自动触发视图更新
  board.value[position.y][position.x] = player
  lastMove.value = position
  history.value.push({ position, player })

  if (checkWin(board.value, position, player)) {
    winner.value = player
    return true
  }

  // 棋盘已满则不再交换玩家，平局统一由 isDraw 推导
  if (moveCount.value === BOARD_SIZE * BOARD_SIZE) return true

  currentPlayer.value = player === 'black' ? 'white' : 'black'

  // 人机模式下轮到 AI 时自动接手
  maybeStartAiTurn()
  return true
}

/** 玩家点击交叉点：AI 思考中或不是人类回合时一律忽略 */
function handlePointClick(position: Position): void {
  if (isAiThinking.value) return
  if (!isHumanTurn.value) return
  applyMove(position)
}

/* ------------------------------ AI 回合 ------------------------------ */

/** 若当前轮到 AI，则启动一次 AI 回合 */
function maybeStartAiTurn(): void {
  if (gameMode.value !== 'pve') return
  if (isGameOver.value) return
  if (currentPlayer.value !== AI_PLAYER) return
  void runAiTurn()
}

/**
 * 执行一次 AI 落子。
 *
 * 三个关键点：
 * 1. 计算前先等 AI_THINK_DELAY_MS，让 Vue 有机会把 isAiThinking 渲染出来；
 * 2. 每次开始都取一个自增令牌，重开 / 切模式会改写令牌；
 *    await 回来后只要令牌对不上就立即放弃——这是防止跨局落子的唯一防线；
 * 3. 落子仍走 applyMove，所以判胜、换手、锁定逻辑与玩家完全一致。
 */
async function runAiTurn(): Promise<void> {
  const taskId = ++aiTaskId
  isAiThinking.value = true

  await new Promise<void>((resolve) => setTimeout(resolve, AI_THINK_DELAY_MS))

  // 等待期间点了重新开始 / 切换了模式：本次任务作废
  if (taskId !== aiTaskId) return

  let move: Position | null = null
  try {
    // 引擎内部会复制棋盘，因此传响应式对象也安全，不会污染 UI 状态
    move = getBestMove(board.value, AI_PLAYER)
  } catch (error) {
    console.error('[五子棋] AI 计算失败：', error)
  }

  // 同步计算期间也可能已被作废，这里再校验一次
  if (taskId !== aiTaskId) return

  isAiThinking.value = false

  if (move && applyMove(move)) return

  // 兜底：AI 未给出有效坐标（仅棋盘已满时可能），找一个空点落下，避免对局卡死
  const fallback = findFirstEmptyPosition()
  if (fallback) applyMove(fallback)
}

/** 兜底用：找到棋盘上第一个空点 */
function findFirstEmptyPosition(): Position | null {
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (board.value[y][x] === 'empty') return { x, y }
    }
  }
  return null
}

/* ------------------------------ 局控逻辑 ------------------------------ */

/**
 * 作废正在进行的 AI 回合。
 * 只改令牌与标志位、不去取消定时器：旧任务醒来后发现令牌不匹配会自行退出。
 */
function cancelAiTurn(): void {
  aiTaskId += 1
  isAiThinking.value = false
}

/**
 * 悔棋：按历史回滚若干手。
 *
 * 人机模式下若 AI 正在思考，先作废那次计算（cancelAiTurn 改令牌），
 * 否则它算完醒来仍会把棋子落回来，用户会觉得"悔棋没生效"。
 */
function undoMove(): void {
  if (!canUndo.value) return

  cancelAiTurn()

  const steps = Math.min(undoCount.value, history.value.length)
  // 越往后弹出的是越早的棋，循环结束时它才是要重新落子的一方
  let restoredPlayer: Player = HUMAN_PLAYER

  for (let i = 0; i < steps; i++) {
    const record = history.value.pop()
    if (!record) break
    board.value[record.position.y][record.position.x] = 'empty'
    restoredPlayer = record.player
  }

  lastMove.value = history.value[history.value.length - 1]?.position ?? null
  currentPlayer.value = restoredPlayer
  // canUndo 已排除"对局结束"，这里只是兜底：万一将来放松了限制，棋盘不会被锁住
  winner.value = null
  hoverPosition.value = null
}

/** 重置整局：作废 AI 任务、清空棋盘、玩家（黑棋）重新先手 */
function resetGame(): void {
  cancelAiTurn()
  board.value = createEmptyBoard()
  currentPlayer.value = HUMAN_PLAYER
  winner.value = null
  lastMove.value = null
  history.value = []
  hoverPosition.value = null
}

/** 切换对局模式：重开一局，避免上一种模式留下半局状态 */
function setMode(mode: GameMode): void {
  if (gameMode.value === mode) return
  gameMode.value = mode
  resetGame()
}

/* ------------------------------ 悬浮预览 ------------------------------ */

/** 鼠标进入交叉点：记录坐标（是否真的显示幽灵由 ghostPosition 决定） */
function handlePointEnter(position: Position): void {
  hoverPosition.value = position
}

/** 鼠标离开交叉点：只有离开的正是当前悬浮点才清除，避免相邻点之间抖动 */
function handlePointLeave(position: Position): void {
  const current = hoverPosition.value
  if (current && current.x === position.x && current.y === position.y) {
    hoverPosition.value = null
  }
}

/** 是否为最近一手，用于在棋子上加标记 */
function isLastMove(position: Position): boolean {
  return lastMove.value?.x === position.x && lastMove.value?.y === position.y
}

/**
 * 交叉点的绝对定位样式。
 * 每个交叉点位于第 (index + 0.5) 个格子的中心，
 * 因此直接用 calc 把索引换算为像素即可，无需测量 DOM。
 */
function positionStyle(position: Position | null): Record<string, string> | undefined {
  if (!position) return undefined
  return {
    left: `calc(${position.x + 0.5} * var(--cell))`,
    top: `calc(${position.y + 0.5} * var(--cell))`,
  }
}
</script>

<template>
  <div class="game">
    <!--
      对局面板：左侧是对局信息（回合 / 手数 / 胜负），右侧是操作
      （模式切换、悔棋、重新开始）。窄屏时两个区域自动换行居中，
      所以无论手机还是桌面都不会横向溢出。
    -->
    <div class="game__panel">
      <div class="game__info">
        <span
          class="game__turn"
          :class="`turn--${winner ?? currentPlayer}`"
          aria-hidden="true"
        ></span>
        <div class="game__text">
          <p class="game__status" role="status">{{ statusText }}</p>
          <p class="game__meta">{{ moveCount === 0 ? '尚未落子' : `已下 ${moveCount} 手` }}</p>
        </div>
      </div>

      <div class="game__actions">
        <div class="mode-switch" role="group" aria-label="对局模式">
          <button
            type="button"
            class="mode-switch__item"
            :class="{ 'mode-switch__item--active': gameMode === 'pvp' }"
            :aria-pressed="gameMode === 'pvp'"
            @click="setMode('pvp')"
          >
            双人
          </button>
          <button
            type="button"
            class="mode-switch__item"
            :class="{ 'mode-switch__item--active': gameMode === 'pve' }"
            :aria-pressed="gameMode === 'pve'"
            @click="setMode('pve')"
          >
            人机
          </button>
        </div>

        <button type="button" class="game__btn" :disabled="!canUndo" @click="undoMove">
          悔棋
        </button>
        <button type="button" class="game__btn" @click="resetGame">重新开始</button>
      </div>
    </div>

    <div
      class="board"
      :class="[
        `board--${currentPlayer}`,
        { 'board--over': isGameOver, 'board--thinking': isAiThinking },
      ]"
    >
      <!-- 星位装饰层：位于网格下方，pointer-events: none 不挡点击 -->
      <div class="board__stars" aria-hidden="true">
        <span
          v-for="star in STAR_POINTS"
          :key="`star-${star.x}-${star.y}`"
          class="star"
          :style="positionStyle(star)"
        ></span>
      </div>

      <!-- 交叉点网格：15 列 × 15 行，每个点是一个透明按钮 -->
      <div class="board__grid">
        <template v-for="y in INDEXES" :key="`row-${y}`">
          <button
            v-for="x in INDEXES"
            :key="`${x}-${y}`"
            type="button"
            class="point"
            :disabled="board[y][x] !== 'empty' || isGameOver || isAiThinking"
            :aria-label="`第 ${y + 1} 行 第 ${x + 1} 列，${
              board[y][x] === 'empty' ? '空' : PLAYER_LABEL[board[y][x] as Player]
            }`"
            @click="handlePointClick({ x, y })"
            @mouseenter="handlePointEnter({ x, y })"
            @mouseleave="handlePointLeave({ x, y })"
          >
            <!-- 已落子：显示立体棋子，最近一手额外带红点标记 -->
            <span
              v-if="board[y][x] !== 'empty'"
              class="stone"
              :class="`stone--${board[y][x]}`"
            >
              <span v-if="isLastMove({ x, y })" class="stone__marker"></span>
            </span>
          </button>
        </template>

        <!--
          幽灵棋子：整个棋盘只渲染一个节点，用绝对定位跟随悬浮交叉点。
          pointer-events: none 是关键——它绝不能拦截下方按钮的点击。
        -->
        <Transition name="ghost-fade">
          <span
            v-if="ghostPosition"
            class="ghost"
            :class="`ghost--${currentPlayer}`"
            :style="positionStyle(ghostPosition)"
            aria-hidden="true"
          ></span>
        </Transition>
      </div>

      <!-- 结算浮层：胜出或平局时出现，覆盖棋盘并阻止误点 -->
      <div v-if="isGameOver" class="result">
        <p class="result__title">
          {{ winner ? `${PLAYER_LABEL[winner]}获胜` : '平局' }}
        </p>
        <p class="result__sub">共 {{ moveCount }} 手</p>
        <button type="button" class="result__button" @click="resetGame">
          再来一局
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.game {
  /*
   * 交叉点间距提到容器级：对局面板要和棋盘等宽，就必须读到同一个 --cell。
   * --board-width 是 15 个格子加左右木质边框的总宽。
   */
  --cell: clamp(20px, 4.2vw, 36px);
  --board-width: calc(var(--cell) * 15 + 20px);

  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: 100%;
}

/* ------------------------------ 对局面板 ------------------------------ */

/*
 * 一分为二：左边信息（回合 / 手数 / 胜负），右边操作（模式 / 悔棋 / 重开）。
 * flex-wrap 是防溢出的关键——空间不够时两区自动换行，而不是把按钮挤到屏幕外。
 */
.game__panel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 14px;
  box-sizing: border-box;
  width: min(100%, var(--board-width));
  padding: 10px 12px 10px 16px;
  border-radius: 18px;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(31, 41, 55, 0.08), 0 8px 20px rgba(31, 41, 55, 0.07);
}

.game__info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* 状态文字可能较长，允许它收缩，避免把操作区顶出面板 */
.game__text {
  min-width: 0;
}

/* 状态栏左侧的小棋子，跟随当前落子方 / 胜者 */
.game__turn {
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 50%;
  transition: background 0.2s;
}

.turn--black {
  background: radial-gradient(circle at 32% 28%, #7c8794, #111111 72%);
  box-shadow: inset 0 -1px 2px rgba(0, 0, 0, 0.55);
}

.turn--white {
  background: radial-gradient(circle at 32% 28%, #ffffff, #cfcfcf 78%);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12), inset 0 -1px 2px rgba(0, 0, 0, 0.18);
}

.game__status {
  font-size: 14px;
  font-weight: 500;
  color: #374151;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.game__meta {
  margin-top: 1px;
  font-size: 11px;
  color: #9ca3af;
  letter-spacing: 0.2px;
  white-space: nowrap;
}

/* ------------------------------ 操作区 ------------------------------ */

.game__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* 模式切换：分段式按钮 */
.mode-switch {
  display: inline-flex;
  gap: 3px;
  padding: 3px;
  border-radius: 999px;
  background: #f3f4f6;
}

.mode-switch__item {
  padding: 4px 12px;
  font-size: 12px;
  color: #6b7280;
  background: transparent;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
}

.mode-switch__item:hover {
  color: #111827;
}

.mode-switch__item--active {
  color: #1f2937;
  font-weight: 500;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(31, 41, 55, 0.16);
}

/* 悔棋与重新开始共用一套按钮样式，禁用态明确区分 */
.game__btn {
  flex: none;
  padding: 4px 13px;
  font-size: 12px;
  color: #4b5563;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  cursor: pointer;
  transition: color 0.2s, border-color 0.2s, background 0.2s;
}

.game__btn:hover:not(:disabled) {
  color: #111827;
  background: #ffffff;
  border-color: #d1d5db;
}

.game__btn:disabled {
  color: #c7ccd4;
  background: #f7f8f9;
  border-color: #eef0f2;
  cursor: not-allowed;
}

/* ------------------------------ 棋盘木质底座 ------------------------------ */

.board {
  /* --cell 由 .game 统一定义，面板与棋盘要读同一个值才能对齐 */
  --line-color: rgba(91, 58, 26, 0.62);
  --wood-light: #e9c99b;
  --wood-dark: #cf9f66;

  position: relative;
  padding: 10px;
  border-radius: 10px;
  background-color: var(--wood-light);
  /*
   * 木纹效果：两层细密条纹（顺纹 + 横向纹理）叠加在径向渐变上，
   * 形成"中间亮、四周略深"的受光感，避免纯色死板。
   */
  background-image:
    repeating-linear-gradient(
      to bottom,
      rgba(122, 74, 30, 0.05) 0 1px,
      transparent 1px 9px
    ),
    repeating-linear-gradient(
      to bottom,
      rgba(255, 255, 255, 0.05) 0 1px,
      transparent 1px 23px
    ),
    radial-gradient(circle at 30% 18%, var(--wood-light), var(--wood-dark));
  box-shadow:
    0 10px 24px rgba(80, 50, 20, 0.26),
    0 2px 4px rgba(80, 50, 20, 0.16),
    inset 0 0 0 1px rgba(255, 255, 255, 0.35),
    inset 0 0 32px rgba(120, 70, 25, 0.16);
  user-select: none;
}

.board--over {
  cursor: default;
}

/* AI 思考中：所有交叉点都是 busy 光标，提示当前不可操作 */
.board--thinking .point {
  cursor: progress;
}

/* 星位层 */
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
  background: rgba(74, 44, 15, 0.72);
}

/* ------------------------------ 网格与棋盘线 ------------------------------ */

/*
 * 棋盘线用渐变绘制：
 * 每个重复单元的宽度 = --cell，线宽 1px，并通过 background-position
 * 整体偏移半个格子，让线正好穿过交叉点（而不是格子边缘）。
 */
.board__grid {
  position: relative;
  display: grid;
  grid-template-columns: repeat(15, var(--cell));
  grid-template-rows: repeat(15, var(--cell));
  background-image:
    repeating-linear-gradient(
      to right,
      var(--line-color) 0 1px,
      transparent 1px var(--cell)
    ),
    repeating-linear-gradient(
      to bottom,
      var(--line-color) 0 1px,
      transparent 1px var(--cell)
    );
  background-position:
    calc(var(--cell) / 2) 0,
    0 calc(var(--cell) / 2);
}

/* 交叉点按钮：完全透明，只负责接收点击 */
.point {
  position: relative;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.point:disabled {
  cursor: default;
}

.point:focus-visible {
  outline: 2px solid rgba(37, 99, 235, 0.7);
  outline-offset: -2px;
  border-radius: 50%;
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

/* 黑棋：径向高光 + 内阴影 + 外部投影，做出玻璃/云子的立体感 */
.stone--black {
  background: radial-gradient(circle at 32% 26%, #8b95a1 0%, #3b3b3b 34%, #0a0a0a 72%);
  box-shadow:
    0 3px 5px rgba(0, 0, 0, 0.42),
    inset -2px -3px 6px rgba(0, 0, 0, 0.6),
    inset 2px 2px 5px rgba(255, 255, 255, 0.16);
}

/* 白棋：高光更强、阴影更浅，避免在木色上"糊"成一片 */
.stone--white {
  background: radial-gradient(circle at 32% 26%, #ffffff 0%, #f4f4f4 44%, #c7c7c7 80%);
  box-shadow:
    0 3px 5px rgba(0, 0, 0, 0.28),
    inset -2px -3px 6px rgba(0, 0, 0, 0.16),
    inset 2px 2px 5px rgba(255, 255, 255, 0.95);
}

/* 最近一手的红色小标记 */
.stone__marker {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 20%;
  height: 20%;
  border-radius: 50%;
  background: #ef4444;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.45);
}

/* 落子时轻微下沉的动效，让手感更实 */
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

/* ------------------------------ 幽灵棋子（落子预览） ------------------------------ */

/*
 * 整个棋盘只有一个幽灵节点，由 hoverPosition 驱动，绝对定位到悬浮的交叉点。
 * - opacity 0.5：半透明，和真实棋子区分开；
 * - pointer-events: none：关键！绝不拦截下方按钮的点击与 hover；
 * - 位置用 calc((index + 0.5) * --cell) 推出来，再用 translate 居中到交叉点。
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

/* 幽灵子用和真实棋子一致的径向渐变，只是不做投影、不带动效 */
.ghost--black {
  background: radial-gradient(circle at 32% 26%, #7c8794, #111111 72%);
}

.ghost--white {
  background: radial-gradient(circle at 32% 26%, #ffffff, #cfcfcf 78%);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
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

/* ------------------------------ 结算浮层 ------------------------------ */

.result {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 10px;
  background: rgba(255, 250, 242, 0.58);
  backdrop-filter: blur(2px);
  animation: result-in 0.22s ease-out;
}

.result__title {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #4a2f14;
}

.result__sub {
  font-size: 13px;
  color: #8a7355;
}

.result__button {
  margin-top: 8px;
  padding: 8px 22px;
  font-size: 14px;
  color: #ffffff;
  background: #a1662f;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  box-shadow: 0 4px 10px rgba(122, 74, 30, 0.32);
  transition: background 0.2s, transform 0.2s;
}

.result__button:hover {
  background: #8b5626;
  transform: translateY(-1px);
}

@keyframes result-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/*
 * 中等宽度：面板内容一行放不下（信息 + 三个控件），
 * 改成上下两行并居中，信息在上一行、操作在下一行。
 */
@media (max-width: 640px) {
  .game__panel {
    justify-content: center;
    padding: 10px 12px;
  }

  .game__info {
    flex: 1 1 100%;
    justify-content: center;
  }

  .game__actions {
    flex: 1 1 100%;
    justify-content: center;
    margin-left: 0;
  }
}

/* 窄屏时收紧间距，保证 15 路棋盘完整可见 */
@media (max-width: 480px) {
  .game {
    /* 棋盘左右内边距变为 6px，面板宽度跟着一起缩，保持等宽 */
    --board-width: calc(var(--cell) * 15 + 12px);
  }

  .board {
    padding: 6px;
  }

  .board__stars {
    inset: 6px;
  }

  .game__status {
    font-size: 13px;
  }
}
</style>
