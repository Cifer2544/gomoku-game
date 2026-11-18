/**
 * 五子棋核心规则
 * ------------------------------------------------------------------
 * 本文件全部是纯函数：给定棋盘数据，返回判定结果。
 * - 不依赖 Vue，不碰 DOM，可被 UI、AI、单元测试直接复用；
 * - 不修改传入的棋盘（除 createEmptyBoard 新建的棋盘外），
 *   谁落子、谁清盘，由调用方决定。
 */

import type { Board, CellState, Player, Position } from './types'

/**
 * 棋盘边长：15 条横线与 15 条竖线，共 15 × 15 = 225 个交叉点。
 * 所有坐标合法性判断都以它为准，改这里即可支持 19 路等变体。
 */
export const BOARD_SIZE = 15

/**
 * 获胜所需连续同类棋子数，标准五子棋为 5。
 * 单独抽成常量，方便实现"四子棋""六子棋"等变体规则。
 */
export const WIN_COUNT = 5

/**
 * 需要检查的四个方向（只取"正向"）。
 * 每个方向用单位向量表示偏移量：
 * - (1, 0)  横向，向右
 * - (0, 1)  纵向，向下
 * - (1, 1)  主对角线，左上 → 右下
 * - (1, -1) 副对角线，左下 → 右上
 *
 * 反向由 `-x / -y` 推导，所以四个方向即可覆盖八条射线。
 */
const DIRECTIONS: readonly Position[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
]

/**
 * 创建一个 15 × 15 的空棋盘。
 *
 * 实现要点：
 * - 外层 `Array.from` 每次回调都会返回一个**全新的**内层数组，
 *   避免 `new Array(15).fill(new Array(15).fill('empty'))` 这种
 *   所有行共享同一个数组引用的经典陷阱（一处落子会"全行变黑"）。
 * - 内层用 `Array<CellState>` 显式标注元素类型，
 *   防止被推断成 `any[]` 或 `string[]`。
 *
 * @returns 全部为 'empty' 的二维数组，访问方式为 board[y][x]
 */
export function createEmptyBoard(): Board {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array<CellState>(BOARD_SIZE).fill('empty'),
  )
}

/**
 * 判断坐标是否落在棋盘范围内。
 * 用于落子前的合法性校验，以及向四周延伸时的边界保护。
 *
 * @param position 待判断的坐标
 * @returns 在棋盘内返回 true
 */
export function isInsideBoard(position: Position): boolean {
  return isInside(position.x, position.y)
}

/**
 * 判断某次落子后，指定玩家是否连成五子而获胜。
 *
 * 算法思路（以落子点为中心的"双向延伸计数"）：
 * 1. 先校验落子点合法：必须在棋盘内，且该点确实是 player 的棋子；
 * 2. 依次检查横、竖、两条斜线共四个方向；
 * 3. 每个方向从落子点出发，向两侧各延伸，统计**同色连续棋子**数量；
 * 4. 两侧数量 + 落子点本身 ≥ 5，即判定获胜。
 *
 * 为什么只需要检查落子点周围：
 * 新增一颗棋子只可能产生"包含这颗棋子的连线"，
 * 因此无需全盘扫描，时间复杂度是 O(1)（最多 4 × 8 次比较）。
 *
 * @param board    当前棋盘（含本次落子）
 * @param lastMove 本次落子的坐标
 * @param player   落子的玩家
 * @returns 连成 5 子及以上返回 true
 */
export function checkWin(
  board: Board,
  lastMove: Position,
  player: Player,
): boolean {
  // 边界保护：坐标越界、或该点不是自己的棋子，都视为无效落子
  if (!isInsideBoard(lastMove)) return false
  if (board[lastMove.y][lastMove.x] !== player) return false

  for (const direction of DIRECTIONS) {
    // 正向延伸（例如向右）+ 反向延伸（例如向左）
    const forward = countConsecutive(board, lastMove, direction, player)
    const backward = countConsecutive(
      board,
      lastMove,
      { x: -direction.x, y: -direction.y },
      player,
    )

    // +1 是落子点自身；两个方向分别从相邻点开始数，不会重复计算中心点
    if (forward + backward + 1 >= WIN_COUNT) return true
  }

  // 四个方向都没连成，未获胜
  return false
}

/**
 * 从 `from` 出发，沿 `step` 方向一直走，
 * 统计连续属于 `player` 的棋子数量（不含起点本身）。
 *
 * 例：黑棋在 (3,7)(4,7)(5,7) 连续，起点取 (2,7)、方向 (1,0)，
 * 返回 3；走到 (6,7) 发现不是黑棋就停下。
 *
 * @param board  当前棋盘
 * @param from   起点（通常是落子点）
 * @param step   单位方向向量，如 { x: 1, y: 0 }
 * @param player 需要统计的玩家颜色
 * @returns 该方向上的连续棋子数
 */
function countConsecutive(
  board: Board,
  from: Position,
  step: Position,
  player: Player,
): number {
  let count = 0
  // 从起点的下一个位置开始计数，避免把起点自身算进来
  let x = from.x + step.x
  let y = from.y + step.y

  while (isInside(x, y) && board[y][x] === player) {
    count += 1
    x += step.x
    y += step.y
  }

  return count
}

/**
 * 坐标越界的底层判断（内部使用，避免每层都构造 Position 对象）。
 * 之所以拆成 x / y 两个参数，是因为延伸循环里坐标是逐步累加的，
 * 直接判断数字比反复构造对象更轻。
 */
function isInside(x: number, y: number): boolean {
  return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE
}
