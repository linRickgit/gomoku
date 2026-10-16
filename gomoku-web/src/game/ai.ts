import {
  BOARD_SIZE,
  EMPTY,
  opponentOf,
  type Board,
  type Difficulty,
  type Position,
  type Stone,
} from './types'
import { findWinLine, inBounds } from './board'

/**
 * 纯前端 AI 引擎。人机对弈时全部计算都在浏览器里完成，不经过后端。
 *
 * 三档难度的差异：
 * - easy：不做搜索，只看单点棋型评分，且叠加较大随机扰动，会漏防、会走闲着
 * - normal：极大极小 2 层 + Alpha-Beta 剪枝，能处理双三、简单的连续冲四
 * - hard：极大极小 4 层 + Alpha-Beta + 候选点剪枝 + 必胜必防快速通道
 */

/** 棋型分值。连五远超其他棋型，保证胜负优先级永远最高 */
const SCORE = {
  FIVE: 10_000_000,
  OPEN_FOUR: 200_000,
  FOUR: 20_000,
  OPEN_THREE: 8_000,
  THREE: 800,
  OPEN_TWO: 300,
  TWO: 60,
  ONE: 10,
  /** 搜索中代表"本方赢"，减去深度让 AI 倾向于更快取胜 */
  WIN: 1_000_000_000,
} as const

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
]

/** 随机扰动基数，仅在 easy 档生效，用于制造"会犯错"的对手 */
const NOISE_BASE = 6_000

interface DifficultyConfig {
  /** 搜索深度，1 表示只看一步（不做极大极小） */
  depth: number
  /** 每层保留的候选点数量 */
  branchFactor: number
  /** 思考时间上限（毫秒），超时立即返回当前最优解 */
  timeBudgetMs: number
  /** 随机扰动系数，0 表示完全不随机 */
  randomness: number
  /**
   * 防守权重：对手棋型在评估中的折扣，越低越容易漏防。
   * 仅对 easy 档（不做搜索）生效 —— 搜索档必须使用严格对称的评估，
   * 否则 negamax 的零和前提不成立，搜索越深反而越吃亏。
   */
  defenseWeight: number
  /** 是否启用极大极小搜索 */
  enableSearch: boolean
  /** 每层迭代加深的步长 */
  depthStep: number
}

const DIFFICULTY_CONFIG: Record<Difficulty, DifficultyConfig> = {
  easy: { depth: 1, branchFactor: 12, timeBudgetMs: 400, randomness: 0.8, defenseWeight: 0.4, enableSearch: false, depthStep: 2 },
  normal: { depth: 4, branchFactor: 10, timeBudgetMs: 1_500, randomness: 0.18, defenseWeight: 1, enableSearch: true, depthStep: 2 },
  // 迭代加深至多 8 层；20 秒是安全上限，绝大多数局面几秒内就能算完
  hard: { depth: 8, branchFactor: 8, timeBudgetMs: 20_000, randomness: 0, defenseWeight: 1, enableSearch: true, depthStep: 2 },
}

/** 迭代加深时距截止时间还剩多少就停止开新一层（毫秒） */
const SAFETY_MARGIN_MS = 60

export interface AiInput {
  board: Board
  aiStone: Stone
  difficulty: Difficulty
}

export interface AiOutput {
  row: number
  col: number
  score: number
  /** 耗时（毫秒） */
  elapsed: number
  /** 搜索的节点数，便于调参 */
  nodes: number
  /** 迭代加深实际完成的最大层数 */
  depthReached: number
  /** 是否因超时提前返回 */
  timedOut: boolean
}

interface SearchContext {
  aiStone: Stone
  branchFactor: number
  maxDepth: number
  deadline: number
  nodes: number
  timedOut: boolean
}

interface Candidate {
  row: number
  col: number
  score: number
}

/**
 * 统计在 (row, col) 落子后，某个方向上形成的连子形态分值。
 * 调用前必须保证 board[row][col] 已经是待评估的棋子。
 */
function scoreDirection(
  board: Board,
  row: number,
  col: number,
  dr: number,
  dc: number,
  stone: Stone,
): number {
  let count = 1
  let openEnds = 0

  let r = row + dr
  let c = col + dc
  while (inBounds(r, c) && board[r][c] === stone) {
    count++
    r += dr
    c += dc
  }
  if (inBounds(r, c) && board[r][c] === EMPTY) openEnds++

  r = row - dr
  c = col - dc
  while (inBounds(r, c) && board[r][c] === stone) {
    count++
    r -= dr
    c -= dc
  }
  if (inBounds(r, c) && board[r][c] === EMPTY) openEnds++

  if (count >= 5) return SCORE.FIVE
  if (count === 4) return openEnds === 2 ? SCORE.OPEN_FOUR : openEnds === 1 ? SCORE.FOUR : 0
  if (count === 3) return openEnds === 2 ? SCORE.OPEN_THREE : openEnds === 1 ? SCORE.THREE : 0
  if (count === 2) return openEnds === 2 ? SCORE.OPEN_TWO : openEnds === 1 ? SCORE.TWO : 0
  return openEnds === 2 ? SCORE.ONE : openEnds === 1 ? 1 : 0
}

/** 在空位 (row, col) 落下一枚 stone 能得到的棋型总分 */
export function scorePoint(board: Board, row: number, col: number, stone: Stone): number {
  if (board[row][col] !== EMPTY) return 0
  board[row][col] = stone
  let total = 0
  for (const [dr, dc] of DIRECTIONS) {
    total += scoreDirection(board, row, col, dr, dc, stone)
  }
  board[row][col] = EMPTY
  return total
}

/**
 * 遍历「已有棋子 radius 格内的空位」，每个空位只回调一次。
 * <p>
 * 这是热路径：搜索中每个节点都要跑一遍。早期版本是「扫全盘 225 格再逐格判断有无邻居」，
 * 复杂度 O(225 × 25)；改成从棋子出发扩散后降到 O(落子数 × 25)，开局阶段快一个数量级。
 */
const VISITED = new Uint8Array(BOARD_SIZE * BOARD_SIZE)

function forEachCandidateCell(board: Board, radius: number, visit: (row: number, col: number) => void): void {
  VISITED.fill(0)
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] === EMPTY) continue
      const minRow = Math.max(0, r - radius)
      const maxRow = Math.min(BOARD_SIZE - 1, r + radius)
      const minCol = Math.max(0, c - radius)
      const maxCol = Math.min(BOARD_SIZE - 1, c + radius)
      for (let rr = minRow; rr <= maxRow; rr++) {
        for (let cc = minCol; cc <= maxCol; cc++) {
          if (board[rr][cc] !== EMPTY) continue
          const key = rr * BOARD_SIZE + cc
          if (VISITED[key] === 1) continue
          VISITED[key] = 1
          visit(rr, cc)
        }
      }
    }
  }
}

/**
 * 全盘静态评估，站在「当前行动方 stone」视角：己方棋型加分，对手棋型等额扣分。
 *
 * 这里必须是严格零和的（eval(对手) === -eval(己方)），否则 negamax
 * 的前提不成立，会出现「搜索越深棋力反而越弱」的怪现象。
 */
function evaluateBoard(board: Board, stone: Stone): number {
  const opponent = opponentOf(stone)
  let total = 0
  forEachCandidateCell(board, 2, (row, col) => {
    total += scorePoint(board, row, col, stone)
    total -= scorePoint(board, row, col, opponent)
  })
  return total
}

/**
 * 生成候选落点：只保留已有棋子附近的空位，并按「进攻分 + 防守分」排序取前 limit 个。
 * 这是搜索性能的关键——15×15 全盘 200+ 空位直接展开会瞬间爆炸。
 */
function generateCandidates(board: Board, stone: Stone, limit: number): Candidate[] {
  const human = opponentOf(stone)
  const list: Candidate[] = []

  forEachCandidateCell(board, 2, (row, col) => {
    const attack = scorePoint(board, row, col, stone)
    const defend = scorePoint(board, row, col, human)
    list.push({ row, col, score: attack + defend })
  })

  list.sort((a, b) => b.score - a.score)
  return list.length > limit ? list.slice(0, limit) : list
}

/** 极大极小 + Alpha-Beta 剪枝，返回站在 stone 视角的分值 */
function negamax(
  board: Board,
  depth: number,
  alpha: number,
  beta: number,
  stone: Stone,
  ctx: SearchContext,
): number {
  ctx.nodes++

  if (Date.now() > ctx.deadline) {
    ctx.timedOut = true
    return 0
  }

  const candidates = generateCandidates(board, stone, ctx.branchFactor)
  if (candidates.length === 0) return 0

  let best = Number.NEGATIVE_INFINITY
  let localAlpha = alpha

  for (const cand of candidates) {
    board[cand.row][cand.col] = stone

    let value: number
    if (findWinLine(board, cand.row, cand.col).length > 0) {
      // 这一手直接连五，层数越浅说明赢得越快
      value = SCORE.WIN - (ctx.maxDepth - depth)
    } else if (depth <= 1) {
      value = evaluateBoard(board, stone)
    } else {
      value = -negamax(board, depth - 1, -beta, -localAlpha, opponentOf(stone), ctx)
    }

    board[cand.row][cand.col] = EMPTY

    if (value > best) best = value
    if (best > localAlpha) localAlpha = best
    if (localAlpha >= beta) break
    if (ctx.timedOut) break
  }

  return best
}

/**
 * 在固定深度下跑完一轮根节点搜索。
 * 调用方需检查 ctx.timedOut：若本层没搜完，结果不可用，应沿用上一层的走法。
 */
function runRootSearch(
  board: Board,
  aiStone: Stone,
  candidates: Candidate[],
  depth: number,
  ctx: SearchContext,
  jitterRange: number,
): { best: Candidate; score: number; trueScore: number } {
  const human = opponentOf(aiStone)
  let best = candidates[0]!
  let bestScore = Number.NEGATIVE_INFINITY
  let bestTrueScore = Number.NEGATIVE_INFINITY
  let alpha = Number.NEGATIVE_INFINITY

  for (const cand of candidates) {
    board[cand.row][cand.col] = aiStone

    let value: number
    if (findWinLine(board, cand.row, cand.col).length > 0) {
      value = SCORE.WIN
    } else if (depth <= 1) {
      value = evaluateBoard(board, aiStone)
    } else {
      value = -negamax(board, depth - 1, Number.NEGATIVE_INFINITY, -alpha, human, ctx)
    }

    board[cand.row][cand.col] = EMPTY

    // 剪枝用的 alpha 必须保持原始分值，否则扰动会破坏剪枝的正确性
    if (value > alpha) alpha = value

    // 扰动只作用在「选哪个」上，且只在分值接近的走法之间起作用：
    // 活四、冲四这类胜负手的分差远大于扰动幅度，不会被换掉
    const scored = jitterRange > 0 ? value + Math.random() * jitterRange : value
    if (scored > bestScore) {
      bestScore = scored
      bestTrueScore = value
      best = cand
    }
    if (ctx.timedOut) break
  }

  return { best, score: bestScore, trueScore: bestTrueScore }
}

/** 不做搜索的档位：单点评分 + 随机扰动 */
function pickByHeuristic(board: Board, aiStone: Stone, cfg: DifficultyConfig): Candidate {
  const human = opponentOf(aiStone)
  const noise = NOISE_BASE * cfg.randomness
  let best: Candidate | null = null
  let bestScore = Number.NEGATIVE_INFINITY

  forEachCandidateCell(board, 2, (row, col) => {
    const attack = scorePoint(board, row, col, aiStone)
    const defend = scorePoint(board, row, col, human) * cfg.defenseWeight
    const score = attack + defend + (noise > 0 ? Math.random() * noise : 0)
    if (score > bestScore) {
      bestScore = score
      best = { row, col, score }
    }
  })

  // 棋盘上还没有任何棋子时落在天元
  return best ?? { row: (BOARD_SIZE - 1) >> 1, col: (BOARD_SIZE - 1) >> 1, score: 0 }
}

/** 找出能让 stone 立刻连五的点 */
function findImmediateWin(board: Board, stone: Stone): Position | null {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] !== EMPTY) continue
      board[r][c] = stone
      const win = findWinLine(board, r, c).length > 0
      board[r][c] = EMPTY
      if (win) return { row: r, col: c }
    }
  }
  return null
}

/** AI 决策入口 */
export function decide({ board, aiStone, difficulty }: AiInput): AiOutput {
  const startedAt = Date.now()
  const cfg = DIFFICULTY_CONFIG[difficulty]
  const human = opponentOf(aiStone)

  // 开局：AI 先手直接占天元
  let stoneCount = 0
  let firstStone: Position | null = null
  for (let r = 0; r < BOARD_SIZE && stoneCount <= 1; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] !== EMPTY) {
        stoneCount++
        if (stoneCount === 1) firstStone = { row: r, col: c }
      }
    }
  }

  const center = (BOARD_SIZE - 1) >> 1
  if (stoneCount === 0) {
    return { row: center, col: center, score: 0, elapsed: Date.now() - startedAt, nodes: 0, depthReached: 0, timedOut: false }
  }

  // 必胜/必防快速通道：任何难度都不会放过这两类点，
  // 避免搜索超时导致 AI 明明能赢却走别的
  const winMove = findImmediateWin(board, aiStone)
  if (winMove) {
    return { ...winMove, score: SCORE.FIVE, elapsed: Date.now() - startedAt, nodes: 0, depthReached: 0, timedOut: false }
  }
  const blockMove = findImmediateWin(board, human)
  if (blockMove) {
    return { ...blockMove, score: SCORE.FIVE, elapsed: Date.now() - startedAt, nodes: 0, depthReached: 0, timedOut: false }
  }

  // AI 后手且盘面只有一子时，贴着对手下，避免开局走散
  if (stoneCount === 1 && firstStone) {
    const candidates: Position[] = []
    for (const [ddr, ddc] of DIRECTIONS) {
      const r = firstStone.row + ddr
      const c = firstStone.col + ddc
      if (inBounds(r, c) && board[r][c] === EMPTY) candidates.push({ row: r, col: c })
    }
    if (candidates.length > 0) {
      const picked = candidates[Math.floor(Math.random() * candidates.length)]!
      return { ...picked, score: 0, elapsed: Date.now() - startedAt, nodes: 0, depthReached: 0, timedOut: false }
    }
  }

  if (!cfg.enableSearch) {
    const picked = pickByHeuristic(board, aiStone, cfg)
    return {
      row: picked.row,
      col: picked.col,
      score: picked.score,
      elapsed: Date.now() - startedAt,
      nodes: 0,
      depthReached: 0,
      timedOut: false,
    }
  }

  const candidates = generateCandidates(board, aiStone, cfg.branchFactor)
  if (candidates.length === 0) {
    return {
      row: center,
      col: center,
      score: 0,
      elapsed: Date.now() - startedAt,
      nodes: 0,
      depthReached: 0,
      timedOut: false,
    }
  }

  const deadline = startedAt + cfg.timeBudgetMs
  // 难度越低扰动越大，只在分值接近的走法之间改变取舍
  const jitterRange = NOISE_BASE * cfg.randomness
  let best: Candidate = candidates[0]!
  let bestScore = Number.NEGATIVE_INFINITY
  let totalNodes = 0
  let depthReached = 0
  let aborted = false

  /**
   * 迭代加深：从 2 层开始，每层 +2，直到时间用尽或到达深度上限。
   * 某一层如果没搜完就被打断，直接丢弃该层结果、沿用上一层的走法，
   * 这样即使 20 秒预算被打断也总有一个完整搜索的答案可用。
   */
  for (let depth = 2; depth <= cfg.depth; depth += cfg.depthStep) {
    const ctx: SearchContext = {
      aiStone,
      branchFactor: cfg.branchFactor,
      maxDepth: depth,
      deadline,
      nodes: 0,
      timedOut: false,
    }

    const round = runRootSearch(board, aiStone, candidates, depth, ctx, jitterRange)
    totalNodes += ctx.nodes
    if (ctx.timedOut) {
      aborted = true
      break
    }

    best = round.best
    bestScore = round.score
    depthReached = depth

    // 已经算出必胜/必败，没必要再往深处算（用未受扰动影响的真实分值判断）
    if (Math.abs(round.trueScore) >= SCORE.WIN - 1000) break
    if (Date.now() >= deadline - SAFETY_MARGIN_MS) {
      aborted = true
      break
    }
  }

  return {
    row: best.row,
    col: best.col,
    score: bestScore,
    elapsed: Date.now() - startedAt,
    nodes: totalNodes,
    depthReached,
    timedOut: aborted,
  }
}
