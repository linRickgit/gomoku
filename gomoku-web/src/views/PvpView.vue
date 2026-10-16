<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ChessBoard from '@/components/ChessBoard.vue'
import { createBoard } from '@/game/board'
import type { Board, Position, Stone } from '@/game/types'
import { claimSeat, createRoom, joinRoom, leaveRoom } from '@/net/api'
import { clearRoom, loadRoom, saveRoom, type RoomSession } from '@/net/roomSession'
import { createGameSocket, type GameSocket, type ServerMessage } from '@/net/gameSocket'
import {
  END_REASON_TEXT,
  RESPONSE_SECONDS,
  toBoard,
  toPositions,
  type RoomState,
} from '@/net/roomState'

const emit = defineEmits<{
  exit: []
}>()

type Phase = 'entry' | 'room'
type Mode = 'create' | 'join'

/** 座位号：0 = 房主(黑)，1 = 对手(白)，-1 = 观战者，-2 = 尚未分配 */
const SEAT_SPECTATOR = -1
const SEAT_UNASSIGNED = -2

const phase = ref<Phase>('entry')
const mode = ref<Mode>('create')
const inputCode = ref('')
const formError = ref('')
const submitting = ref(false)

/** 本地留存的上一局凭证，用于刷新 / 掉线后坐回原座位 */
const saved = ref<RoomSession | null>(null)

const seat = ref(SEAT_UNASSIGNED)
const room = ref<RoomState | null>(null)
const socket = ref<GameSocket | null>(null)
const connectionError = ref('')
const notice = ref('')
const copied = ref(false)

/** 本次进入房间拿到的凭证（观战席位也要留着，用于稍后自动入座） */
const roomToken = ref('')
/** 观战状态下正在等待座位空出 */
const waitingForSeat = ref(false)
let seatTimer: number | undefined

/** 对手发来请求（悔棋 / 互换阵营）时的倒计时，超时自动拒绝 */
const requestCountdown = ref(0)
let requestTimer: number | undefined
let noticeTimer: number | undefined

const isSpectator = computed(() => seat.value === SEAT_SPECTATOR)

const board = computed<Board>(() => (room.value ? toBoard(room.value.board) : createBoard()))
const winLine = computed<Position[]>(() => (room.value ? toPositions(room.value.winLine) : []))
const lastMove = computed<Position | null>(() => {
  const raw = room.value?.lastMove
  if (!raw || raw.length < 2) return null
  return { row: raw[0]!, col: raw[1]! }
})

const opponent = computed(() => {
  if (!room.value || seat.value < 0) return null
  return room.value.players[1 - seat.value] ?? null
})
const me = computed(() => (room.value && seat.value >= 0 ? room.value.players[seat.value] ?? null : null))
const selfStone = computed<Stone>(() => (seat.value === 1 ? 2 : 1))

const myTurn = computed(
  () => !isSpectator.value && room.value?.status === 'PLAYING' && room.value.turn === seat.value,
)
const interactive = computed(() => myTurn.value)

/** 服务端说"没有待处理请求"时两种请求都为空 */
const noPendingRequest = computed(
  () => room.value?.undoRequestFrom == null && room.value?.swapRequestFrom == null,
)

/** 对手发来的悔棋请求，需要我响应 */
const incomingUndo = computed(() => {
  const from = room.value?.undoRequestFrom
  return from !== null && from !== undefined && from !== seat.value && !isSpectator.value
})
/** 我发出的悔棋请求，等待对方响应 */
const outgoingUndo = computed(() => room.value?.undoRequestFrom === seat.value && !isSpectator.value)

/** 对手发来的互换阵营请求 */
const incomingSwap = computed(() => {
  const from = room.value?.swapRequestFrom
  return from !== null && from !== undefined && from !== seat.value && !isSpectator.value
})
/** 我发出的互换阵营请求 */
const outgoingSwap = computed(() => room.value?.swapRequestFrom === seat.value && !isSpectator.value)

const canRequestUndo = computed(
  () =>
    !isSpectator.value &&
    room.value?.status === 'PLAYING' &&
    (room.value?.moveCount ?? 0) > 0 &&
    noPendingRequest.value,
)

const canRequestSwap = computed(
  () =>
    !isSpectator.value &&
    room.value?.status === 'PLAYING' &&
    (room.value?.players[1] ?? null) !== null &&
    noPendingRequest.value,
)

const opponentOffline = computed(() => opponent.value !== null && !opponent.value.online)

const statusText = computed(() => {
  const state = room.value
  if (!state) return connectionError.value || '连接已断开'
  if (isSpectator.value) return waitingForSeat.value ? '正在等待空位…' : '观战中'
  if (state.status === 'WAITING') return '等待对手加入…'
  if (state.status === 'FINISHED') {
    if (state.winnerSeat == null) return '和棋'
    const reason = state.endReason ? END_REASON_TEXT[state.endReason] ?? '' : ''
    return state.winnerSeat === seat.value ? `你赢了 · ${reason}` : `你输了 · ${reason}`
  }
  return myTurn.value ? '轮到你落子' : '等待对手落子…'
})

function showNotice(text: string): void {
  notice.value = text
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 4000)
}

function handleMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'room_state': {
      const state = message.payload as unknown as RoomState
      room.value = state
      // 互换阵营后座位号会变，用服务端标记的 isSelf 重新确认自己是谁
      const selfIndex = (state.players ?? []).findIndex((player) => player && player.isSelf === true)
      if (selfIndex >= 0 && selfIndex !== seat.value) {
        seat.value = selfIndex
        const session = loadRoom()
        if (session && session.code === state.code) {
          saveRoom({ ...session, seat: selfIndex })
        }
        saved.value = loadRoom()
      }
      break
    }
    case 'rematch_pending':
      showNotice('对手已申请再来一局，等待你确认')
      break
    case 'error': {
      const payload = message.payload ?? {}
      const text = String(payload.message ?? '操作失败')
      showNotice(text)
      if (payload.fatal === true) {
        connectionError.value = text
        room.value = null
        // 凭证失效或房间已解散，继续重连也没有意义，清掉本地凭证
        if (payload.code === 'INVALID_TOKEN' || payload.code === 'ROOM_NOT_FOUND') {
          clearRoom()
          saved.value = null
        }
      }
      break
    }
    case 'room_closed':
      connectionError.value = String(message.payload?.reason ?? '房间已解散')
      room.value = null
      break
    case 'welcome':
    case 'pong':
      break
    default:
      break
  }
}

function connect(code: string, token: string): void {
  socket.value?.close()
  connectionError.value = ''
  roomToken.value = token
  socket.value = createGameSocket(code, token, {
    onMessage: handleMessage,
    onClose: () => {
      connectionError.value = '连接已断开，正在自动重连…'
    },
    onError: () => {
      if (!connectionError.value) {
        connectionError.value = '连接服务端失败，请确认后端已启动'
      }
    },
    onReconnect: () => {
      connectionError.value = ''
      showNotice('已重新连接，继续对局')
    },
  })
}

/** 进入房间后登记凭证；坐到观战席时不覆盖，避免把真座位挤掉 */
function remember(response: { code: string; seat: number; token: string; nickname: string }): void {
  if (response.seat < 0) {
    return
  }
  saveRoom({
    code: response.code,
    seat: response.seat,
    token: response.token,
    nickname: response.nickname,
  })
  saved.value = loadRoom()
}

async function enterRoom(): Promise<void> {
  formError.value = ''
  if (mode.value === 'join' && !/^\d{6}$/.test(inputCode.value.trim())) {
    formError.value = '房间码必须是 6 位数字'
    return
  }
  submitting.value = true
  try {
    const response =
      mode.value === 'create' ? await createRoom() : await joinRoom(inputCode.value.trim(), savedTokenFor(inputCode.value.trim()))
    seat.value = response.seat
    phase.value = 'room'
    remember(response)
    connect(response.code, response.token)
  } catch (error) {
    const message = error instanceof Error ? error.message : '操作失败，请重试'
    formError.value = message
    // 房间已经被回收，本地凭证没有意义了
    if (message.includes('房间不存在')) {
      clearRoom()
      saved.value = null
    }
  } finally {
    submitting.value = false
  }
}

/** 只有本地凭证与要进的房间一致时才带上，否则按新玩家处理 */
function savedTokenFor(code: string): string | null {
  const session = saved.value
  return session && session.code === code ? session.token : null
}

/** 带着本地凭证回到上次的座位（刷新页面后的"继续对局"） */
async function resumeSaved(): Promise<void> {
  const session = saved.value
  if (!session) return
  submitting.value = true
  formError.value = ''
  try {
    const response = await joinRoom(session.code, session.token)
    if (response.seat < 0) {
      // 凭证已失效（座位被接管），留着只会让人反复掉进观战席
      clearRoom()
      saved.value = null
      formError.value = '原座位已被占用，本次以观战身份进入'
    }
    seat.value = response.seat
    phase.value = 'room'
    remember(response)
    connect(response.code, response.token)
  } catch (error) {
    // 房间已被回收，清掉凭证回到正常的建房 / 加入流程
    clearRoom()
    saved.value = null
    formError.value = error instanceof Error ? error.message : '操作失败，请重试'
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  saved.value = loadRoom()
})

function onPlace(position: Position): void {
  if (!myTurn.value) return
  socket.value?.send('move', { row: position.row, col: position.col })
}

function resign(): void {
  socket.value?.send('resign')
}

function requestRematch(): void {
  socket.value?.send('rematch')
}

function requestUndo(): void {
  if (!canRequestUndo.value) return
  socket.value?.send('undo_request')
  showNotice('已发起悔棋请求，等待对手同意')
}

function requestSwap(): void {
  if (!canRequestSwap.value) return
  socket.value?.send('swap_request')
  showNotice('已申请互换阵营，等待对手同意')
}

function respondUndo(agree: boolean): void {
  stopCountdown()
  socket.value?.send('undo_response', { agree })
  showNotice(agree ? '已同意对手悔棋' : '已拒绝对手悔棋')
}

function respondSwap(agree: boolean): void {
  stopCountdown()
  socket.value?.send('swap_response', { agree })
  showNotice(agree ? '已同意互换阵营' : '已拒绝互换阵营')
}

// ---------- 对手请求的响应倒计时 ----------

function startCountdown(): void {
  requestCountdown.value = RESPONSE_SECONDS
  window.clearInterval(requestTimer)
  requestTimer = window.setInterval(() => {
    requestCountdown.value -= 1
    if (requestCountdown.value <= 0) {
      stopCountdown()
      // 超时按拒绝处理，请求自动消失，不会卡住对局
      if (incomingUndo.value) {
        socket.value?.send('undo_response', { agree: false })
      } else if (incomingSwap.value) {
        socket.value?.send('swap_response', { agree: false })
      }
      showNotice(`超过 ${RESPONSE_SECONDS} 秒未响应，已自动拒绝`)
    }
  }, 1000)
}

function stopCountdown(): void {
  window.clearInterval(requestTimer)
  requestTimer = undefined
  requestCountdown.value = 0
}

watch(
  () => [room.value?.undoRequestFrom, room.value?.swapRequestFrom],
  () => {
    if (incomingUndo.value || incomingSwap.value) {
      startCountdown()
    } else {
      stopCountdown()
    }
  },
  { deep: true },
)

// ---------- 观战者自动入座 ----------

/**
 * 观战状态下周期性重试入座。
 * 进来时若正好撞上对方掉线的保护期（默认 5 秒），会先被安排观战；
 * 保护期一过这里就会自动坐上，不需要手动刷新页面。
 */
function startSeatRetry(): void {
  stopSeatRetry()
  waitingForSeat.value = true
  seatTimer = window.setInterval(() => {
    void tryClaimSeat()
  }, 2500)
}

function stopSeatRetry(): void {
  window.clearInterval(seatTimer)
  seatTimer = undefined
  waitingForSeat.value = false
}

async function tryClaimSeat(): Promise<void> {
  const code = room.value?.code
  if (!code || !roomToken.value || seat.value !== SEAT_SPECTATOR) return
  try {
    const response = await claimSeat(code, roomToken.value)
    if (response.seat < 0) return
    // 坐上了：换座位号并重建连接，握手时会按新座位绑定
    stopSeatRetry()
    seat.value = response.seat
    remember(response)
    connect(response.code, response.token)
    showNotice('已入座，可以开始对局')
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    // 房间没了或凭证失效，重试下去也没有意义
    if (message.includes('房间不存在') || message.includes('不在这个房间')) {
      stopSeatRetry()
    }
  }
}

watch(
  () => [phase.value, seat.value],
  () => {
    if (phase.value === 'room' && seat.value === SEAT_SPECTATOR) {
      startSeatRetry()
    } else {
      stopSeatRetry()
    }
  },
)

async function copyCode(): Promise<void> {
  const code = room.value?.code
  if (!code) return
  try {
    await navigator.clipboard.writeText(code)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    showNotice('复制失败，请手动选中房间码')
  }
}

/**
 * 主动离开：先通知服务端立刻释放座位，再断开连接。
 *
 * 与直接关页面的区别是「不算掉线」——不走 5 秒保护期，别人可以马上进来接着下。
 * 本地凭证仍然保留：座位只要没被别人占，自己回来还能坐回原位。
 */
async function leave(): Promise<void> {
  stopCountdown()
  stopSeatRetry()
  const code = room.value?.code
  const token = roomToken.value
  if (code && token) {
    try {
      await leaveRoom(code, token)
    } catch {
      // 房间已经不在了，本地照常退出即可
    }
  }
  socket.value?.close()
  socket.value = null
  room.value = null
  roomToken.value = ''
  seat.value = SEAT_UNASSIGNED
  phase.value = 'entry'
  connectionError.value = ''
  emit('exit')
}

onBeforeUnmount(() => {
  stopCountdown()
  stopSeatRetry()
  // 只要是从房间界面离开（而不是关页面），都按主动让位处理，不占掉线保护期
  const code = room.value?.code
  const token = roomToken.value
  if (code && token) {
    leaveRoom(code, token).catch(() => {
      // 已经不在房间里了，忽略
    })
  }
  socket.value?.close()
  window.clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="pvp">
    <section v-if="phase === 'entry'" class="entry">
      <header class="bar">
        <button type="button" class="ghost" @click="emit('exit')">返回</button>
        <h2 class="bar__title">联机大厅</h2>
      </header>

      <div class="tabs">
        <button
          type="button"
          class="tab"
          :class="{ 'tab--active': mode === 'create' }"
          @click="mode = 'create'"
        >
          创建房间
        </button>
        <button type="button" class="tab" :class="{ 'tab--active': mode === 'join' }" @click="mode = 'join'">
          加入房间
        </button>
      </div>

      <div v-if="saved" class="resume">
        <div class="resume__text">
          上次的对局还在：房间 <strong>{{ saved.code }}</strong>
          <span v-if="saved.seat >= 0">（{{ saved.seat === 0 ? '执黑' : '执白' }}）</span>
        </div>
        <button type="button" class="primary primary--sm" :disabled="submitting" @click="resumeSaved">
          回到我的座位
        </button>
      </div>

      <form class="form" @submit.prevent="enterRoom">
        <label v-if="mode === 'join'" class="field">
          <span>房间码</span>
          <input
            v-model="inputCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            placeholder="6 位数字"
          />
        </label>

        <p class="tip">
          无需登录，进入后系统自动分配昵称。座位只要没人占就能直接坐下接着下，
          对方掉线后有 5 秒保护期留给重连，之后座位才对外开放。
          两个座位都有人在线时进入观战，一旦有人离开会自动补位。双方都掉线后棋盘保留 10 分钟。
        </p>

        <p v-if="formError" class="error">{{ formError }}</p>

        <button type="submit" class="primary" :disabled="submitting">
          {{ submitting ? '处理中…' : mode === 'create' ? '创建房间' : '进入房间' }}
        </button>
      </form>
    </section>

    <section v-else class="room">
      <header class="bar">
        <button type="button" class="ghost" @click="leave">离开</button>
        <div class="bar__info">
          <span v-if="isSpectator" class="badge badge--watch">观战模式</span>
          <span v-else class="badge">{{ seat === 0 ? '执黑' : '执白' }}</span>
          <span class="turn">{{ statusText }}</span>
        </div>
      </header>

      <div class="room__layout">
        <div class="room__board">
          <ChessBoard
            :board="board"
            :interactive="interactive"
            :last-move="lastMove"
            :win-line="winLine"
            :self-stone="selfStone"
            @place="onPlace"
          />
        </div>

        <aside class="room__side">
          <div class="code">
            <div class="code__label">房间码</div>
            <div class="code__value">{{ room?.code ?? '------' }}</div>
            <button type="button" class="ghost" @click="copyCode">{{ copied ? '已复制' : '复制' }}</button>
          </div>

          <div class="players">
            <div class="player" :class="{ 'player--offline': me && !me.online }">
              <span class="dot" :class="seat === 0 ? 'dot--black' : 'dot--white'" />
              <span>{{ me?.nickname ?? '我' }}{{ isSpectator ? '' : '（我）' }}</span>
            </div>
            <div class="player" :class="{ 'player--offline': opponentOffline }">
              <span class="dot" :class="seat === 0 ? 'dot--white' : 'dot--black'" />
              <span>
                {{ opponent?.nickname ?? '等待对手加入' }}
                <em v-if="opponentOffline">（掉线中，等待重连）</em>
              </span>
            </div>
            <div v-if="(room?.spectatorCount ?? 0) > 0" class="player player--muted">
              {{ room?.spectatorCount }} 人观战
            </div>
          </div>

          <div v-if="incomingUndo" class="undo-bar">
            <span>对手请求悔棋，{{ requestCountdown }} 秒后自动拒绝</span>
            <div class="undo-bar__actions">
              <button type="button" class="primary primary--sm" @click="respondUndo(true)">同意</button>
              <button type="button" class="ghost" @click="respondUndo(false)">拒绝</button>
            </div>
          </div>

          <div v-if="incomingSwap" class="undo-bar">
            <span>对手申请互换阵营，{{ requestCountdown }} 秒后自动拒绝</span>
            <div class="undo-bar__actions">
              <button type="button" class="primary primary--sm" @click="respondSwap(true)">同意</button>
              <button type="button" class="ghost" @click="respondSwap(false)">拒绝</button>
            </div>
          </div>

          <p v-if="outgoingUndo" class="notice">已发起悔棋请求，等待对手回应…</p>
          <p v-if="outgoingSwap" class="notice">已申请互换阵营，等待对手回应…</p>
          <p v-if="opponentOffline && room?.status === 'PLAYING'" class="notice">
            对手已掉线，棋盘原地保留。掉线后 5 秒内座位仍为他保留，之后其他人可以进来接着下。
          </p>
          <p v-if="waitingForSeat" class="notice">房间暂时满员，一旦有空位会自动入座，无需刷新。</p>
          <p v-if="notice" class="notice">{{ notice }}</p>
          <p v-if="connectionError" class="error">{{ connectionError }}</p>

          <div v-if="!isSpectator" class="actions">
            <button type="button" class="ghost" :disabled="!canRequestUndo" @click="requestUndo">
              悔棋
            </button>
            <button type="button" class="ghost" :disabled="!canRequestSwap" @click="requestSwap">
              互换阵营
            </button>
            <button type="button" class="ghost" :disabled="room?.status !== 'PLAYING'" @click="resign">
              认输
            </button>
            <button
              type="button"
              class="primary"
              :disabled="room?.status !== 'FINISHED'"
              @click="requestRematch"
            >
              {{ room?.rematchVotes?.[seat] ? '等待对手确认…' : '再来一局' }}
            </button>
          </div>
        </aside>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pvp {
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  /* 左右内边距设 0，让棋盘真正占满屏幕宽度；上下保留间距 */
  padding: 20px 0;
  box-sizing: border-box;
}

/* 默认（手机 / 竖屏 / 横屏）：上下堆叠，棋盘占满整个宽度 */
.room__layout {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.room__board {
  width: 100%;
}

.room__side {
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
  .room__layout {
    flex-direction: row;
    align-items: flex-start;
    gap: 24px;
  }

  .room__board {
    flex: 1 1 auto;
    min-width: 0;
    /* 棋盘是正方形，限制其宽度不超过视口高度，避免棋盘过高需要大幅滚动 */
    max-width: calc(100vh - 160px);
  }

  .room__side {
    flex: 0 0 300px;
    position: sticky;
    top: 20px;
  }
}

/* 建房/加入界面：离屏幕左右留 16px，避免内容贴边 */
.entry {
  padding: 0 16px;
  box-sizing: border-box;
}

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  /* 顶栏离屏幕左右留 16px */
  padding: 0 16px;
}

.bar__title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
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

.badge--watch {
  background: #f2eefc;
  color: #6b4fd8;
}

.turn {
  font-size: 14px;
  color: #444;
}

.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.tab {
  flex: 1;
  padding: 10px;
  border: 1px solid #dcdcdc;
  border-radius: 8px;
  background: #fafafa;
  color: #555;
  cursor: pointer;
  font-size: 14px;
}

.tab--active {
  border-color: #2f6fed;
  background: #eef3ff;
  color: #2f6fed;
}

.form {
  background: #fff;
  border: 1px solid #e6e6e6;
  border-radius: 12px;
  padding: 18px;
}

.field {
  display: block;
  margin-bottom: 14px;
}

.field span {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: #555;
}

.field input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #dcdcdc;
  border-radius: 8px;
  font-size: 14px;
  box-sizing: border-box;
}

.field input:focus {
  outline: none;
  border-color: #2f6fed;
}

.tip {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.6;
  color: #888;
}

.resume {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  padding: 12px 16px;
  border: 1px solid #bcd4ff;
  border-radius: 12px;
  background: #eef3ff;
}

.resume__text {
  font-size: 13px;
  color: #2f6fed;
}

.primary {
  flex: 1;
  padding: 11px;
  border: none;
  border-radius: 8px;
  background: #2f6fed;
  color: #fff;
  font-size: 15px;
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.primary--sm {
  flex: 0 0 auto;
  padding: 7px 14px;
  font-size: 13px;
}

.ghost {
  padding: 9px 14px;
  border: 1px solid #d5d5d5;
  border-radius: 8px;
  background: #fff;
  color: #444;
  font-size: 13px;
  cursor: pointer;
}

.ghost:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.code {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 12px;
  background: #fff;
  border: 1px solid #e6e6e6;
  border-radius: 12px;
}

.code__label {
  font-size: 12px;
  color: #999;
}

.code__value {
  flex: 1;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.players {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-bottom: 14px;
  font-size: 13px;
  color: #555;
}

.player {
  display: flex;
  align-items: center;
  gap: 6px;
}

.player--offline {
  color: #c0392b;
}

.player--muted {
  color: #999;
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid #999;
}

.dot--black {
  background: #1b1b1b;
}

.dot--white {
  background: #fbfbfb;
}

.undo-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
  padding: 10px 14px;
  border: 1px solid #f0c98a;
  border-radius: 10px;
  background: #fff6e5;
  font-size: 13px;
  color: #8a5a00;
}

.undo-bar__actions {
  display: flex;
  gap: 8px;
}

.notice {
  margin: 12px 0 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: #fff6e5;
  color: #8a5a00;
  font-size: 13px;
}

.error {
  margin: 12px 0 0;
  color: #c0392b;
  font-size: 13px;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
</style>
