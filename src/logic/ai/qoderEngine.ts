/**
 * Qoder 高级引擎适配层
 * ------------------------------------------------------------------
 * 为什么不把 index.ts 整份复制过来：
 * 复制会产出两份 800 行算法，任何一处修复都要改两遍，很快就会各自漂移，
 * 最后"对弈用的引擎"和"实战用的引擎"不是同一个东西，统计就失去意义。
 *
 * 因此这里只做一层薄封装：把 index.ts 的 getBestMove 暴露成竞技场需要的
 * `getQoderBestMove`，并把时间预算从实战的 1200ms 压到对弈用的 200ms。
 */

import { getBestMove } from './index'
import type { Board, Player, Position } from '../types'

/**
 * 自动对弈时的单步时限（毫秒）。
 *
 * 为什么是 200 而不是实战的 1200：竞技场要连走几十手，每步 1.2s 会让页面像卡死。
 * 为什么不压到 100：VCF 预算按 timeLimit * 0.4 折算，100ms 时算杀只剩 40ms，
 * 基本算不出连冲四，实测会出现 100+ 手还分不出胜负的拖沓对局。
 * 200ms 时 VCF 有 80ms，对局质量明显提升（实测 4:0 完胜极简版）。
 */
export const QODER_BATTLE_TIME_MS = 200

/**
 * 高级引擎入口。
 *
 * @param board       当前棋盘
 * @param player      AI 执子颜色
 * @param timeLimitMs 本步时间预算，默认 200ms
 */
export function getQoderBestMove(
  board: Board,
  player: Player,
  timeLimitMs: number = QODER_BATTLE_TIME_MS,
): Position {
  return getBestMove(board, player, timeLimitMs)
}
