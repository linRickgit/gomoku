<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ChessBoard from '@/components/ChessBoard.vue'
import { createBoard, cloneBoard, findWinLine, isBoardFull } from '@/game/board'
import { BLACK, EMPTY, WHITE, opponentOf, type Board, type Difficulty, type Position, type Stone } from '@/game/types'
import type { AiOutput } from '@/game/ai'
import type { AiWorkerRequest, AiWorkerResponse } from '@/game/ai.worker'

const props = defineProps<{
  difficulty: Difficulty
  playerStone: Stone
}>()

const emit = defineEmits<{
  exit: []
}>()

const board = ref<Board>(createBoard())
const current = ref<Stone>(BLACK)
const status = ref<'playing' | 'thinking' | 'finished'>('playing')
const winner = ref<Stone | 0>(0)
const lastMove = ref<Position | null>(null)
const winLine = ref<Position[]>([])
const history = ref<Position[]>([])
/** snapshots[i] = 落第 i 手之前的棋盘，用于悔棋 */
const snapshots = ref<Board[]>([])
const aiStats = ref<{ elapsed: number; nodes: number; depthReached: number } | null>(null)

const aiStone = computed<Stone>(() => opponentOf(props.playerStone))
const isPlayerTurn = computed(() => current.value === props.playerStone)
const interactive = computed(() => status.value === 'playing' && isPlayerTurn.value)

let worker: Worker | null = null
let requestSeq = 0
const pending = new Map<number, { resolve: (value: AiOutput) => void; reject: (reason: Error) => void }>()

const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
}

function askAi(currentBoard: Board, stone: Stone): Promise<AiOutput> {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('AI 工作线程未就绪'))
      return
    }
    const id = ++requestSeq
    pending.set(id, { resolve, reject })
    const request: AiWorkerRequest = {
      id,
      board: cloneBoard(currentBoard),
      aiStone: stone,
      difficulty: props.difficulty,
    }
    worker.postMessage(request)
  })
}

function placeStone(position: Position, stone: Stone): void {
  snapshots.value.push(cloneBoard(board.value))
  board.value[position.row]![position.col] = stone
  history.value.push(position)
  lastMove.value = position
  current.value = opponentOf(stone)
}

function settle(position: Position, stone: Stone): boolean {
  const line = findWinLine(board.value, position.row, position.col)
  if (line.length > 0) {
    winner.value = stone
    winLine.value = line
    status.value = 'finished'
    return true
  }
  if (isBoardFull(board.value)) {
    winner.value = 0
    status.value = 'finished'
    return true
  }
  return false
}

async function onPlace(position: Position): Promise<void> {
  if (status.value !== 'playing' || !isPlayerTurn.value) return
  if (board.value[position.row]?.[position.col] !== EMPTY) return

  placeStone(position, props.playerStone)
  if (settle(position, props.playerStone)) return

  status.value = 'thinking'
  try {
    const result = await askAi(board.value, aiStone.value)
    aiStats.value = { elapsed: result.elapsed, nodes: result.nodes, depthReached: result.depthReached }
    const aiMove: Position = { row: result.row, col: result.col }
    placeStone(aiMove, aiStone.value)
    status.value = settle(aiMove, aiStone.value) ? 'finished' : 'playing'
  } catch (error) {
    status.value = 'playing'
    console.error('AI 决策失败', error)
  }
}

/** 悔棋：一路回退到"又轮到玩家落子"为止 */
function undo(): void {
  if (status.value === 'thinking') return
  const total = snapshots.value.length
  if (total === 0) return

  let undoCount = 1
  while (undoCount < total) {
    const nextIndex = total - undoCount
    const nextStone: Stone = nextIndex % 2 === 0 ? BLACK : WHITE
    if (nextStone === props.playerStone) break
    undoCount++
  }

  const keep = total - undoCount
  board.value = keep === 0 ? createBoard() : cloneBoard(snapshots.value[keep - 1]!)
  snapshots.value = snapshots.value.slice(0, keep)
  history.value = history.value.slice(0, keep)
  lastMove.value = history.value[history.value.length - 1] ?? null
  current.value = props.playerStone
  status.value = 'playing'
  winner.value = 0
  winLine.value = []
}

function restart(): void {
  board.value = createBoard()
  current.value = BLACK
  status.value = 'playing'
  winner.value = 0
  lastMove.value = null
  winLine.value = []
  history.value = []
  snapshots.value = []
  aiStats.value = null
  if (aiStone.value === BLACK) {
    void runAiFirstMove()
  }
}

function resign(): void {
  if (status.value === 'finished') return
  winner.value = aiStone.value
  status.value = 'finished'
  winLine.value = []
}

async function runAiFirstMove(): Promise<void> {
  status.value = 'thinking'
  try {
    const result = await askAi(board.value, aiStone.value)
    aiStats.value = { elapsed: result.elapsed, nodes: result.nodes, depthReached: result.depthReached }
    const aiMove: Position = { row: result.row, col: result.col }
    placeStone(aiMove, aiStone.value)
    status.value = settle(aiMove, aiStone.value) ? 'finished' : 'playing'
  } catch (error) {
    status.value = 'playing'
    console.error('AI 决策失败', error)
  }
}

function handleWorkerMessage(event: MessageEvent<AiWorkerResponse>): void {
  const data = event.data
  const deferred = pending.get(data.id)
  if (!deferred) return
  pending.delete(data.id)
  if (data.ok) {
    deferred.resolve({
      row: data.row,
      col: data.col,
      score: data.score,
      elapsed: data.elapsed,
      nodes: data.nodes,
      depthReached: data.depthReached,
      timedOut: data.timedOut,
    })
  } else {
    deferred.reject(new Error(data.error))
  }
}

onMounted(() => {
  worker = new Worker(new URL('../game/ai.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = handleWorkerMessage
  if (aiStone.value === BLACK) {
    void runAiFirstMove()
  }
})

onBeforeUnmount(() => {
  worker?.terminate()
  worker = null
  pending.clear()
})

const statusText = computed(() => {
  if (status.value === 'thinking') return 'AI 正在思考…'
  if (status.value === 'finished') {
    if (winner.value === 0) return '和棋'
    return winner.value === props.playerStone ? '你赢了' : 'AI 赢了'
  }
  return isPlayerTurn.value ? '轮到你落子' : '轮到 AI 落子'
})
</script>

<template>
  <div class="pve">
    <header class="bar">
      <button type="button" class="ghost" @click="emit('exit')">返回</button>
      <div class="bar__info">
        <span class="badge">人机 · {{ DIFFICULTY_LABEL[difficulty] }}</span>
        <span class="turn">{{ statusText }}</span>
      </div>
    </header>

    <div class="pve__layout">
      <div class="pve__board">
        <ChessBoard
          :board="board"
          :interactive="interactive"
          :last-move="lastMove"
          :win-line="winLine"
          :self-stone="playerStone"
          @place="onPlace"
        />
      </div>

      <aside class="pve__side">
        <div class="panel">
          <div class="meta">
            <span>你执{{ playerStone === BLACK ? '黑' : '白' }}</span>
            <span>第 {{ history.length }} 手</span>
            <span v-if="aiStats">
              AI 用时 {{ aiStats.elapsed }}ms · 搜索 {{ aiStats.depthReached }} 层 · {{ aiStats.nodes }} 节点
            </span>
          </div>
          <div class="actions">
            <button type="button" class="ghost" :disabled="status === 'thinking' || history.length === 0" @click="undo">
              悔棋
            </button>
            <button type="button" class="ghost" :disabled="status === 'finished'" @click="resign">认输</button>
            <button type="button" class="primary" @click="restart">重新开局</button>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.pve {
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  /* 左右内边距设 0，让棋盘真正占满屏幕宽度；上下保留间距 */
  padding: 20px 0;
  box-sizing: border-box;
}

/* 默认（手机 / 竖屏 / 横屏）：上下堆叠，棋盘占满整个宽度 */
.pve__layout {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pve__board {
  width: 100%;
}

.pve__side {
  width: 100%;
  /* 侧栏内容离屏幕左右留 16px，棋盘本身仍占满宽度 */
  padding: 0 16px;
  box-sizing: border-box;
}

/*
 * 仅当「宽且高都够」时（真正的桌面显示器）才左右并排。
 * 手机横屏宽度常 ≥900px 但高度很小，若只看宽度会误入并排分支，
 * 并被 max-width 用视口高度把棋盘压窄。加 min-height 约束即可避免。
 */
@media (min-width: 900px) and (min-height: 640px) {
  .pve__layout {
    flex-direction: row;
    align-items: flex-start;
    gap: 24px;
  }

  .pve__board {
    flex: 1 1 auto;
    min-width: 0;
    /* 棋盘是正方形，限制其宽度不超过视口高度，避免棋盘过高需要大幅滚动 */
    max-width: calc(100vh - 160px);
  }

  .pve__side {
    flex: 0 0 300px;
    position: sticky;
    top: 20px;
  }
}

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  /* 顶栏离屏幕左右留 16px */
  padding: 0 16px;
}

.bar__info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.badge {
  padding: 3px 10px;
  border-radius: 999px;
  background: #eef3ff;
  color: #2f6fed;
  font-size: 12px;
}

.turn {
  font-size: 14px;
  color: #444;
}

.panel {
  margin-top: 18px;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 12px;
  font-size: 12px;
  color: #888;
}

.actions {
  display: flex;
  gap: 10px;
}

.primary {
  flex: 1;
  padding: 10px;
  border: none;
  border-radius: 8px;
  background: #2f6fed;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}

.ghost {
  padding: 10px 16px;
  border: 1px solid #d5d5d5;
  border-radius: 8px;
  background: #fff;
  color: #444;
  font-size: 14px;
  cursor: pointer;
}

.ghost:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
