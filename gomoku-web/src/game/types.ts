/** 棋子：0 = 空，1 = 黑，2 = 白 */
export type Stone = 0 | 1 | 2

/** 棋盘，board[row][col] */
export type Board = Stone[][]

/** AI 难度 */
export type Difficulty = 'easy' | 'normal' | 'hard'

export interface Position {
  row: number
  col: number
}

export const BOARD_SIZE = 15
/** 连成几子算胜 */
export const WIN_COUNT = 5

export const BLACK: Stone = 1
export const WHITE: Stone = 2
export const EMPTY: Stone = 0

export function opponentOf(stone: Stone): Stone {
  return stone === BLACK ? WHITE : BLACK
}
