/**
 * AI 引擎正确性测试：必胜/必防判定、自动对弈、思考耗时
 *
 * 前置：先执行 esbuild 打包
 *   cd gomoku-web && npx esbuild ../tools/ai-test-entry.ts --bundle --format=esm --platform=node --outfile=../tools/.tmp/ai-entry.mjs
 * 运行：node tools/ai-test.mjs
 */

import {
  decide,
  findWinLine,
  createBoard,
  cloneBoard,
  isBoardFull,
  BLACK,
  WHITE,
  opponentOf,
} from './.tmp/ai-entry.mjs'

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? ` -> ${detail}` : ''}`)
  }
}

function autoPlay(blackDifficulty, whiteDifficulty) {
  const board = createBoard()
  let current = BLACK
  let maxStepMs = 0
  let totalSteps = 0

  for (let step = 0; step < 225; step++) {
    const difficulty = current === BLACK ? blackDifficulty : whiteDifficulty
    const result = decide({ board, aiStone: current, difficulty })
    maxStepMs = Math.max(maxStepMs, result.elapsed)
    totalSteps++

    board[result.row][result.col] = current
    if (findWinLine(board, result.row, result.col).length > 0) {
      return { winner: current, maxStepMs, totalSteps }
    }
    if (isBoardFull(board)) {
      return { winner: 0, maxStepMs, totalSteps }
    }
    current = opponentOf(current)
  }
  return { winner: 0, maxStepMs, totalSteps }
}

console.log('\n[1] 开局')
{
  const board = createBoard()
  const result = decide({ board, aiStone: BLACK, difficulty: 'normal' })
  check('空盘开局落在天元 (7,7)', result.row === 7 && result.col === 7, `(${result.row},${result.col})`)
}

console.log('\n[2] 一步取胜判定（三档都必须抓住）')
for (const difficulty of ['easy', 'normal', 'hard']) {
  const board = createBoard()
  board[7][3] = BLACK
  board[7][4] = BLACK
  board[7][5] = BLACK
  board[7][6] = BLACK
  board[0][0] = WHITE
  board[0][1] = WHITE

  const result = decide({ board, aiStone: BLACK, difficulty })
  const isWinning = result.row === 7 && (result.col === 2 || result.col === 7)
  check(`${difficulty} 档抓住四连的制胜点`, isWinning, `(${result.row},${result.col})`)
}

console.log('\n[3] 必防判定（对手四连必须堵）')
for (const difficulty of ['easy', 'normal', 'hard']) {
  const board = createBoard()
  board[7][3] = WHITE
  board[7][4] = WHITE
  board[7][5] = WHITE
  board[7][6] = WHITE
  board[0][0] = BLACK
  board[0][1] = BLACK

  const result = decide({ board, aiStone: BLACK, difficulty })
  const blocks = result.row === 7 && (result.col === 2 || result.col === 7)
  check(`${difficulty} 档堵住对手四连`, blocks, `(${result.row},${result.col})`)
}

console.log('\n[4] 自动对弈：困难（黑） vs 简单（白）')
{
  const started = Date.now()
  const result = autoPlay('hard', 'easy')
  const label = result.winner === 0 ? '和棋' : result.winner === BLACK ? '困难档胜' : '简单档胜'
  console.log(
    `  → ${label}，共 ${result.totalSteps} 手，单步最长 ${result.maxStepMs}ms，总耗时 ${Date.now() - started}ms`,
  )
  check('困难档能击败简单档', result.winner === BLACK, label)
  check('困难档单步耗时在预算内（<=20s）', result.maxStepMs <= 20_000, `${result.maxStepMs}ms`)
}

function series(blackDifficulty, whiteDifficulty, games) {
  let blackWins = 0
  let whiteWins = 0
  let draws = 0
  let maxStepMs = 0
  for (let i = 0; i < games; i++) {
    const result = autoPlay(blackDifficulty, whiteDifficulty)
    maxStepMs = Math.max(maxStepMs, result.maxStepMs)
    if (result.winner === BLACK) blackWins++
    else if (result.winner === WHITE) whiteWins++
    else draws++
  }
  return { blackWins, whiteWins, draws, maxStepMs }
}

console.log('\n[5] 强度梯度：普通 vs 简单（5 局，含先后手各半）')
{
  const blackSide = series('normal', 'easy', 3)
  const whiteSide = series('easy', 'normal', 2)
  const normalWins = blackSide.blackWins + whiteSide.whiteWins
  console.log(
    `  → 普通档胜 ${normalWins}/5 局（黑先 ${blackSide.blackWins}/3，白后 ${whiteSide.whiteWins}/2），单步最长 ${Math.max(blackSide.maxStepMs, whiteSide.maxStepMs)}ms`,
  )
  check('普通档整体强于简单档（>=3/5）', normalWins >= 3, `${normalWins}/5`)
}

console.log('\n[6] 强度梯度：困难 vs 普通（5 局，含先后手各半）')
{
  const blackSide = series('hard', 'normal', 3)
  const whiteSide = series('normal', 'hard', 2)
  const hardWins = blackSide.blackWins + whiteSide.whiteWins
  console.log(
    `  → 困难档胜 ${hardWins}/5（黑先 ${blackSide.blackWins}/3，白后 ${whiteSide.whiteWins}/2），单步最长 ${Math.max(blackSide.maxStepMs, whiteSide.maxStepMs)}ms`,
  )
  check('困难档整体强于普通档（>=3/5）', hardWins >= 3, `${hardWins}/5`)
}

console.log('\n[7] 自动对弈：普通 vs 普通（验证不崩溃、能正常终局）')
{
  const result = autoPlay('normal', 'normal')
  const label = result.winner === 0 ? '和棋' : result.winner === BLACK ? '黑胜' : '白胜'
  console.log(`  → ${label}，共 ${result.totalSteps} 手，单步最长 ${result.maxStepMs}ms`)
  check('普通档对局能正常终局', result.winner !== 0 || result.totalSteps === 225, label)
  check('普通档单步耗时在预算内（<=1500ms）', result.maxStepMs <= 1500, `${result.maxStepMs}ms`)
}

console.log('\n[6] 棋盘不会被下满前崩溃（困难档 20 手压力测试）')
{
  const board = createBoard()
  let current = BLACK
  let crashed = false
  try {
    for (let i = 0; i < 20; i++) {
      const result = decide({ board, aiStone: current, difficulty: 'hard' })
      board[result.row][result.col] = current
      current = opponentOf(current)
    }
  } catch (error) {
    crashed = true
    console.log(`  → 异常：${error.message}`)
  }
  check('连续 20 手困难档决策无异常', !crashed)
  check('棋盘状态仍有效', cloneBoard(board).length === 15)
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`)
process.exit(failed === 0 ? 0 : 1)
