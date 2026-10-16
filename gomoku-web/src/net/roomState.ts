import type { Board, Position, Stone } from '@/game/types'
import { createBoard } from '@/game/board'

/** 与后端 RoomState / PlayerState 字段一一对应 */

export interface PlayerState {
  seat: number
  nickname: string
  online: boolean
  isSelf: boolean | null
}

export type RoomStatus = 'WAITING' | 'PLAYING' | 'FINISHED'

export interface RoomState {
  code: string
  status: RoomStatus
  /** 当前该哪个座位落子 */
  turn: number
  board: number[][]
  players: (PlayerState | null)[]
  /** 获胜座位号；和棋为 null */
  winnerSeat: number | null
  endReason: string | null
  /** 五连坐标，形如 [[row, col], ...] */
  winLine: number[][]
  moveCount: number
  rematchVotes: boolean[]
  /** 最后一手 [row, col]，尚未落子时为 null */
  lastMove: number[] | null
  /** 谁在等对方同意悔棋，null 表示没有待处理请求 */
  undoRequestFrom: number | null
  /** 谁在等对方同意互换阵营，null 表示没有待处理请求 */
  swapRequestFrom: number | null
  /** 当前观战人数 */
  spectatorCount: number
}

/** 后端给的是 number[][]，这里统一转成前端的强类型棋盘 */
export function toBoard(matrix: number[][]): Board {
  if (!matrix || matrix.length === 0) return createBoard()
  return matrix.map((row) => row.map((value) => value as Stone))
}

export function toPositions(matrix: number[][]): Position[] {
  if (!matrix || matrix.length === 0) return []
  return matrix.map(([row = 0, col = 0]) => ({ row, col }))
}

export const END_REASON_TEXT: Record<string, string> = {
  NONE: '对局进行中',
  FIVE_IN_ROW: '五子连珠',
  RESIGN: '认输',
  DRAW: '棋盘下满，和棋',
}

/** 悔棋 / 互换阵营请求的有效响应时间，超时自动拒绝（与服务端无耦合，纯前端约定） */
export const RESPONSE_SECONDS = 30

/** @deprecated 用 RESPONSE_SECONDS */
export const UNDO_RESPONSE_SECONDS = RESPONSE_SECONDS
