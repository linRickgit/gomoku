<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { BOARD_SIZE, EMPTY, type Board, type Position, type Stone } from '@/game/types'

const props = withDefaults(
  defineProps<{
    board: Board
    /** 是否响应点击落子 */
    interactive?: boolean
    /** 最后一手，用于标记 */
    lastMove?: Position | null
    /** 获胜的五连，用于高亮 */
    winLine?: Position[]
    /** 自己执的棋子，用于绘制落子预览（1 黑 / 2 白） */
    selfStone?: Stone
  }>(),
  {
    interactive: true,
    lastMove: null,
    winLine: () => [],
    selfStone: 1,
  },
)

const emit = defineEmits<{
  /** 第二次点击确认后真正落子 */
  place: [position: Position]
  /** 预览位置变化，null 表示取消预览 */
  preview: [position: Position | null]
}>()

const wrapperRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)

/**
 * 两段式落子：第一次点击只做标记，第二次点击同一位置才真正落子。
 * 这样可以先看清楚落点再确认，避免手滑下错。
 */
const pending = ref<Position | null>(null)

/** 棋盘边缘留白，供坐标外的棋子完整显示（原 22，减半让网格更贴边） */
const PADDING = 11
/** 星位 */
const STAR_POINTS: ReadonlyArray<readonly [number, number]> = [
  [3, 3],
  [3, 11],
  [7, 7],
  [11, 3],
  [11, 11],
]

let ctx: CanvasRenderingContext2D | null = null
let cssSize = 0
let cellSize = 0
let observer: ResizeObserver | null = null

function pixelOf(index: number): number {
  return PADDING + index * cellSize
}

function indexOf(px: number): number {
  return Math.round((px - PADDING) / cellSize)
}

function resize(): void {
  const canvas = canvasRef.value
  const wrapper = wrapperRef.value
  if (!canvas || !wrapper) return

  cssSize = Math.max(240, wrapper.clientWidth)
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(cssSize * dpr)
  canvas.height = Math.round(cssSize * dpr)
  canvas.style.width = `${cssSize}px`
  canvas.style.height = `${cssSize}px`

  ctx = canvas.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  cellSize = (cssSize - PADDING * 2) / (BOARD_SIZE - 1)
}

function drawBoardBackground(c: CanvasRenderingContext2D): void {
  c.fillStyle = '#e8c68d'
  c.fillRect(0, 0, cssSize, cssSize)

  c.strokeStyle = '#8d6b3f'
  c.lineWidth = 1
  c.beginPath()
  for (let i = 0; i < BOARD_SIZE; i++) {
    c.moveTo(pixelOf(0), pixelOf(i))
    c.lineTo(pixelOf(BOARD_SIZE - 1), pixelOf(i))
    c.moveTo(pixelOf(i), pixelOf(0))
    c.lineTo(pixelOf(i), pixelOf(BOARD_SIZE - 1))
  }
  c.stroke()

  c.strokeStyle = '#5c4423'
  c.lineWidth = 2
  c.strokeRect(pixelOf(0), pixelOf(0), pixelOf(BOARD_SIZE - 1) - pixelOf(0), pixelOf(BOARD_SIZE - 1) - pixelOf(0))

  c.fillStyle = '#5c4423'
  for (const [row, col] of STAR_POINTS) {
    c.beginPath()
    c.arc(pixelOf(col), pixelOf(row), 3, 0, Math.PI * 2)
    c.fill()
  }
}

function drawStone(c: CanvasRenderingContext2D, row: number, col: number, stone: number): void {
  const x = pixelOf(col)
  const y = pixelOf(row)
  const radius = cellSize * 0.44

  c.beginPath()
  c.arc(x, y, radius, 0, Math.PI * 2)
  c.fillStyle = stone === 1 ? '#1b1b1b' : '#fbfbfb'
  c.fill()
  c.lineWidth = 1
  c.strokeStyle = stone === 1 ? '#000000' : '#b0b0b0'
  c.stroke()

  // 高光，让棋子有点立体感
  c.beginPath()
  c.arc(x - radius * 0.32, y - radius * 0.32, radius * 0.2, 0, Math.PI * 2)
  c.fillStyle = stone === 1 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.95)'
  c.fill()
}

function draw(): void {
  const c = ctx
  if (!c || cssSize === 0) return

  drawBoardBackground(c)

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const stone = props.board[row]?.[col] ?? EMPTY
      if (stone !== EMPTY) {
        drawStone(c, row, col, stone)
      }
    }
  }

  if (props.lastMove) {
    const x = pixelOf(props.lastMove.col)
    const y = pixelOf(props.lastMove.row)
    c.beginPath()
    c.arc(x, y, cellSize * 0.16, 0, Math.PI * 2)
    c.fillStyle = '#d94b3f'
    c.fill()
  }

  drawPending(c)

  if (props.winLine.length > 0) {
    const first = props.winLine[0]!
    const last = props.winLine[props.winLine.length - 1]!
    c.beginPath()
    c.moveTo(pixelOf(first.col), pixelOf(first.row))
    c.lineTo(pixelOf(last.col), pixelOf(last.row))
    c.strokeStyle = '#d94b3f'
    c.lineWidth = 3
    c.stroke()
  }
}

/** 绘制待确认的落子标记：半透明棋子 + 红色高亮框 */
function drawPending(c: CanvasRenderingContext2D): void {
  const position = pending.value
  if (!position) return
  if ((props.board[position.row]?.[position.col] ?? EMPTY) !== EMPTY) return

  const x = pixelOf(position.col)
  const y = pixelOf(position.row)

  c.save()
  c.globalAlpha = 0.5
  drawStone(c, position.row, position.col, props.selfStone)
  c.restore()

  c.strokeStyle = '#d94b3f'
  c.lineWidth = 2
  const half = cellSize * 0.48
  c.strokeRect(x - half, y - half, half * 2, half * 2)
}

function handleClick(event: MouseEvent): void {
  if (!props.interactive) return
  const canvas = canvasRef.value
  if (!canvas) return

  const rect = canvas.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top

  const col = indexOf(x)
  const row = indexOf(y)
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return

  // 点击位置离交叉点太远就忽略，避免误触
  const dx = x - pixelOf(col)
  const dy = y - pixelOf(row)
  if (Math.hypot(dx, dy) > cellSize * 0.5) return

  if ((props.board[row]?.[col] ?? EMPTY) !== EMPTY) return

  const current = pending.value
  if (current && current.row === row && current.col === col) {
    // 第二次点同一格：确认落子
    clearPending(false)
    emit('place', { row, col })
  } else {
    // 第一次点：只做标记；点其他格子则把标记挪过去
    pending.value = { row, col }
    emit('preview', pending.value)
    draw()
  }
}

/** 取消预览标记。notify 为 false 时不向外抛事件（用于棋盘已被更新的场景） */
function clearPending(notify: boolean): void {
  if (pending.value === null) return
  pending.value = null
  if (notify) {
    emit('preview', null)
  }
  draw()
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    clearPending(true)
  }
}

onMounted(() => {
  resize()
  draw()
  if (wrapperRef.value) {
    observer = new ResizeObserver(() => {
      resize()
      draw()
    })
    observer.observe(wrapperRef.value)
  }
  window.addEventListener('keydown', handleKeyDown)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  window.removeEventListener('keydown', handleKeyDown)
})

watch(
  () => [props.board, props.lastMove, props.winLine],
  () => {
    // 棋盘内容变化说明这一步已经走完，预览标记自然作废
    clearPending(false)
    draw()
  },
  { deep: true },
)

// 轮到对方或 AI 思考时，不允许继续保留落子标记
watch(
  () => props.interactive,
  (value) => {
    if (!value) clearPending(false)
  },
)
</script>

<template>
  <div ref="wrapperRef" class="board" :class="{ 'board--locked': !interactive }">
    <canvas ref="canvasRef" @click="handleClick" />
    <p v-if="pending" class="board__hint">
      已标记落点 · 再次点击同一位置确认落子，按 Esc 取消
    </p>
  </div>
</template>

<style scoped>
.board {
  width: 100%;
  margin: 0 auto;
  line-height: 0;
}

.board canvas {
  display: block;
  border-radius: 6px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
}

.board--locked canvas {
  cursor: not-allowed;
}

.board:not(.board--locked) canvas {
  cursor: pointer;
}

.board__hint {
  margin: 10px 0 0;
  line-height: 1.5;
  text-align: center;
  font-size: 13px;
  color: #b1590f;
}
</style>
