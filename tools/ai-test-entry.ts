// AI 测试脚手架入口：把内部模块导出给 Node 测试脚本使用
export { decide } from '../gomoku-web/src/game/ai'
export { findWinLine, createBoard, isBoardFull, cloneBoard } from '../gomoku-web/src/game/board'
export { BLACK, WHITE, EMPTY, opponentOf } from '../gomoku-web/src/game/types'
