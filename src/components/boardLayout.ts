/**
 * 棋盘布局常量（两个棋盘组件共用）
 * ------------------------------------------------------------------
 * GameBoard 与 AiBattle 渲染的是同一种 15 × 15 交叉点棋盘，
 * 索引序列与星位坐标完全一致。此前两份组件各写一份副本，
 * 改一处容易漏另一处，统一挪到这里只保留一份来源。
 *
 * 星位只是视觉装饰、不参与胜负判定，所以没有放进 logic/rules.ts，
 * 避免让纯规则模块掺入渲染相关的常量。
 */

import { BOARD_SIZE } from '../logic/rules'
import type { Position } from '../logic/types'

/** 坐标索引集合 0 ~ BOARD_SIZE - 1，供模板双重循环使用（y 行 / x 列） */
export const INDEXES: readonly number[] = Array.from(
  { length: BOARD_SIZE },
  (_, index) => index,
)

/** 星位（天元与四个小目），只做视觉装饰，不影响规则
 *
 * 坐标按 15 路布局写定（3 / 7 / 11）；若将来把 BOARD_SIZE 改成 19，
 * 这些点位需要同步改为 3 / 9 / 15，否则星位会错位。
 */
export const STAR_POINTS: readonly Position[] = [
  { x: 3, y: 3 },
  { x: 11, y: 3 },
  { x: 7, y: 7 },
  { x: 3, y: 11 },
  { x: 11, y: 11 },
]
