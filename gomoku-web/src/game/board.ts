import { BOARD_SIZE, EMPTY, WIN_COUNT, type Board, type Position, type Stone } from './types'

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // 横
  [1, 0], // 竖
  [1, 1], // 主对角
  [1, -1], // 副对角
]

export function createBoard(): Board {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => EMPTY as Stone),
  )
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice() as Stone[])
}

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE
}

/**
 * 判断落在 (row, col) 的这颗子是否形成连珠。
 * 与后端 GameEngine.findWinLine 保持完全一致的规则：无禁手，横竖斜四向连五即胜。
 *
 * @returns 构成连珠的坐标数组（长度 >= 5），未获胜时返回空数组
 */
export function findWinLine(board: Board, row: number, col: number): Position[] {
  if (!inBounds(row, col)) return []
  const stone = board[row][col]
  if (stone === EMPTY) return []

  for (const [dr, dc] of DIRECTIONS) {
    const line: Position[] = [{ row, col }]

    for (let step = 1; step < WIN_COUNT; step++) {
      const r = row + dr * step
      const c = col + dc * step
      if (inBounds(r, c) && board[r][c] === stone) {
        line.push({ row: r, col: c })
      } else {
        break
      }
    }
    for (let step = 1; step < WIN_COUNT; step++) {
      const r = row - dr * step
      const c = col - dc * step
      if (inBounds(r, c) && board[r][c] === stone) {
        line.unshift({ row: r, col: c })
      } else {
        break
      }
    }

    if (line.length >= WIN_COUNT) {
      return line
    }
  }
  return []
}

export function isBoardFull(board: Board): boolean {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] === EMPTY) return false
    }
  }
  return true
}

export function countStones(board: Board): number {
  let count = 0
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] !== EMPTY) count++
    }
  }
  return count
}
