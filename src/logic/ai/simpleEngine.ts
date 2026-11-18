/**
 * 极简版 AI 引擎（对照用）
 * ------------------------------------------------------------------
 * 定位：给「AI 竞技场」提供一个结构完全不同的对照组，用来量化
 *       "单点棋型评估 + 固定深度搜索" 与 "增量评估 + PVS + VCF" 的差距。
 *
 * 与 index.ts 的核心差异：
 * 1. 评估只做单点棋型（evalPoint 从落点向两侧连续扫描），没有整盘评估；
 * 2. 搜索是手写的 alpha-beta（max/min 两层），固定深度 4；
 * 3. 没有 Zobrist、置换表、迭代加深、VCF 算杀、时间预算。
 *
 * 已知短板（保留原样，保证对照实验是真实的）：
 * - `alphaBeta` 在 `depth === 0` 时返回 0，所有非"成五/被成五"分支同分，
 *   负 Alpha-Beta 实际上退化为"取候选排序第一"，深度 4 只起到 2 层
 *   强制胜负检测的作用；
 * - `getCandidates` 遇到"对手能成活四"就只返回 1 个点，直接跳过搜索。
 *
 * 这两点决定了它在安静中局里下不过 index.ts，不要用它替换主引擎。
 */

import type { Board, Player, Position } from '../types'

const SIZE = 15
const CELLS = 225
const EMPTY = 0
const BLACK = 1
const WHITE = 2

// 棋型评分
const S_FIVE = 10_000_000
const S_LIVE_FOUR = 1_000_000
const S_RUSH_FOUR = 100_000
const S_LIVE_THREE = 10_000
const S_SLEEP_THREE = 1_000
const S_LIVE_TWO = 100
const S_SLEEP_TWO = 10

/** 一维棋盘，getSimpleBestMove 每次调用前整体重载 */
let board = new Int8Array(CELLS)

// 四个方向偏移量：横(1)、竖(15)、主对角(16)、副对角(14)
const DIRS = [1, 15, 16, 14]

function opp(c: number): number {
  return c === BLACK ? WHITE : BLACK
}

/**
 * 从 idx 沿 off 方向移动 dir 步是否合法。
 * 横向与两条对角线都需要防止跨行，纵向天然安全。
 */
function canP(idx: number, off: number, dir: 1 | -1): boolean {
  const next = idx + off * dir
  if (next < 0 || next >= CELLS) return false
  if (off === 1) return dir === 1 ? idx % SIZE !== SIZE - 1 : idx % SIZE !== 0
  if (off === 16) return dir === 1 ? idx % SIZE !== SIZE - 1 : idx % SIZE !== 0
  if (off === 14) return dir === 1 ? idx % SIZE !== 0 : idx % SIZE !== SIZE - 1
  return true
}

/** idx 处落下 c 后是否连成五子 */
function checkWin(idx: number, c: number): boolean {
  for (const off of DIRS) {
    let cnt = 1
    let p = idx
    while (canP(p, off, 1)) {
      p += off
      if (board[p] === c) cnt++
      else break
    }
    p = idx
    while (canP(p, off, -1)) {
      p -= off
      if (board[p] === c) cnt++
      else break
    }
    if (cnt >= 5) return true
  }
  return false
}

/**
 * 评估 idx 落子后、沿 off 方向形成的棋型分值。
 *
 * 从落点向两侧连续扫描同色子，遇到空位记为开口并停止。
 * 因为落点本身会被填上，所以"左右连续长度 + 1"就是落子后该方向的连续长度，
 * 跳型（如 XX_XX 落中间）也能被正确识别成五连。
 */
function evalPoint(idx: number, off: number, c: number): number {
  let leftOpen = false
  let rightOpen = false
  let leftCount = 0
  let rightCount = 0

  let p = idx
  while (canP(p, off, -1)) {
    p -= off
    if (board[p] === c) leftCount++
    else if (board[p] === EMPTY) {
      leftOpen = true
      break
    } else break
  }

  p = idx
  while (canP(p, off, 1)) {
    p += off
    if (board[p] === c) rightCount++
    else if (board[p] === EMPTY) {
      rightOpen = true
      break
    } else break
  }

  const total = leftCount + rightCount + 1
  const openEnds = (leftOpen ? 1 : 0) + (rightOpen ? 1 : 0)

  if (total >= 5) return S_FIVE
  if (total === 4) return openEnds === 2 ? S_LIVE_FOUR : openEnds === 1 ? S_RUSH_FOUR : 0
  if (total === 3) return openEnds === 2 ? S_LIVE_THREE : openEnds === 1 ? S_SLEEP_THREE : 0
  if (total === 2) return openEnds === 2 ? S_LIVE_TWO : openEnds === 1 ? S_SLEEP_TWO : 0
  return 0
}

/** 综合四个方向 + 中心加权的单点价值 */
function evalMove(idx: number, c: number): number {
  let score = 0
  for (const off of DIRS) score += evalPoint(idx, off, c)

  const x = idx % SIZE
  const y = (idx - x) / SIZE
  score += Math.max(0, 14 - (Math.abs(x - 7) + Math.abs(y - 7)))
  return score
}

/**
 * 生成候选点（已有棋子周围 2 格内的空位），按"攻击分 + 防守分 × 1.2"降序取前 12。
 *
 * 注意：以下两个提前 return 会让函数只返回 1 个点，调用方会直接落子、不进入搜索。
 * 这在"一步成五/必须堵五"时是正确的，但"对手能成活四"时属于过度提前。
 */
function getCandidates(myC: number): number[] {
  const enC = opp(myC)
  const list: { i: number; s: number }[] = []
  const visited = new Uint8Array(CELLS)
  let hasPiece = false

  for (let i = 0; i < CELLS; i++) {
    if (board[i] === EMPTY) continue
    hasPiece = true

    const x = i % SIZE
    const y = (i - x) / SIZE
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue

        const ni = ny * SIZE + nx
        if (board[ni] !== EMPTY || visited[ni]) continue
        visited[ni] = 1

        const myScore = evalMove(ni, myC)
        const enScore = evalMove(ni, enC)

        // 我方能成五 → 直接落这里；对手能成五/活四 → 只能堵这里
        if (myScore >= S_FIVE) return [ni];
        if (enScore >= S_FIVE) return [ni];

        list.push({ i: ni, s: myScore + enScore * 1.2 })
      }
    }
  }

  if (!hasPiece) return [7 * SIZE + 7] // 空盘走天元

  list.sort((a, b) => b.s - a.s)
  return list.slice(0, 12).map(item => item.i)
}

/**
 * 固定深度 alpha-beta。
 * 叶子返回 0 —— 这是本引擎最大的短板，见文件头说明。
 */
function alphaBeta(depth: number, alpha: number, beta: number, isMax: boolean, myC: number): number {
  if (depth === 0) return 0

  const currentC = isMax ? myC : opp(myC)
  const candidates = getCandidates(currentC)
  if (candidates.length === 0) return 0

  if (isMax) {
    let maxEval = -Infinity
    for (const idx of candidates) {
      board[idx] = currentC
      if (checkWin(idx, currentC)) maxEval = S_FIVE
      else maxEval = Math.max(maxEval, alphaBeta(depth - 1, alpha, beta, false, myC))
      board[idx] = EMPTY

      alpha = Math.max(alpha, maxEval)
      if (beta <= alpha) break
    }
    return maxEval
  }

  let minEval = Infinity
  for (const idx of candidates) {
    board[idx] = currentC
    if (checkWin(idx, currentC)) minEval = -S_FIVE
    else minEval = Math.min(minEval, alphaBeta(depth - 1, alpha, beta, true, myC))
    board[idx] = EMPTY

    beta = Math.min(beta, minEval)
    if (beta <= alpha) break
  }
  return minEval
}

/** 搜索深度：固定 4 层（根 1 层 + 3 层递归） */
const SEARCH_DEPTH = 4

/**
 * 极简版主入口：返回最佳落子坐标。
 * 与 index.ts 的 getBestMove 签名保持一致，便于在竞技场里互换。
 */
export function getSimpleBestMove(b: Board, aiPlayer: Player): Position {
  board.fill(EMPTY)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const cell = b[y][x]
      if (cell === 'black') board[y * SIZE + x] = BLACK
      else if (cell === 'white') board[y * SIZE + x] = WHITE
    }
  }

  const myC = aiPlayer === 'black' ? BLACK : WHITE
  const cands = getCandidates(myC)
  if (cands.length === 0) return { x: -1, y: -1 }
  if (cands.length === 1) {
    const only = cands[0]
    return { x: only % SIZE, y: (only - (only % SIZE)) / SIZE }
  }

  let bestMove = cands[0]
  let bestScore = -Infinity

  for (const idx of cands) {
    board[idx] = myC
    if (checkWin(idx, myC)) {
      board[idx] = EMPTY
      return { x: idx % SIZE, y: (idx - (idx % SIZE)) / SIZE }
    }

    const score = alphaBeta(SEARCH_DEPTH - 1, -Infinity, Infinity, false, myC)
    board[idx] = EMPTY

    if (score > bestScore) {
      bestScore = score
      bestMove = idx
    }
  }

  return { x: bestMove % SIZE, y: (bestMove - (bestMove % SIZE)) / SIZE }
}
