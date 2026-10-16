import { decide, type AiOutput } from './ai'
import type { Board, Difficulty, Stone } from './types'

/**
 * AI 跑在 Web Worker 里：困难档 4 层搜索会持续占用 CPU，
 * 放主线程会导致落子瞬间页面卡死。
 */

export interface AiWorkerRequest {
  id: number
  board: Board
  aiStone: Stone
  difficulty: Difficulty
}

export type AiWorkerResponse =
  | ({ id: number; ok: true } & AiOutput)
  | { id: number; ok: false; error: string }

const ctx = self as unknown as Worker

ctx.onmessage = (event: MessageEvent<AiWorkerRequest>) => {
  const { id, board, aiStone, difficulty } = event.data
  try {
    const result = decide({ board, aiStone, difficulty })
    ctx.postMessage({ id, ok: true, ...result } satisfies AiWorkerResponse)
  } catch (error) {
    ctx.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies AiWorkerResponse)
  }
}
