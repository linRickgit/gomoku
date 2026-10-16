export interface ServerMessage {
  type: string
  payload?: Record<string, unknown>
}

export interface GameSocketHandlers {
  onMessage: (message: ServerMessage) => void
  /** 连接断开（含重连失败）时触发 */
  onClose: () => void
  onError: () => void
  /** 断线重连成功时触发，前端可据此清除"连接已断开"提示 */
  onReconnect?: () => void
}

export interface GameSocket {
  send: (type: string, payload?: Record<string, unknown>) => void
  close: () => void
}

/**
 * WebSocket 基础地址（不含 /ws/game 这一段，由调用方拼接）。
 * 1) 打包时指定了 `VITE_BASE`，则由其推导（http(s) -> ws(s)），前端与后端可不同源；
 * 2) 开发期连本地 8080；
 * 3) 生产环境同源时跟随页面所在 host。
 */
function wsBaseUrl(): string {
  const raw = import.meta.env.VITE_BASE as string | undefined
  if (raw) {
    return raw.replace(/^http/, 'ws').replace(/\/$/, '')
  }
  if (import.meta.env.DEV) {
    return 'ws://localhost:8080'
  }
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}`
}

const HEARTBEAT_INTERVAL = 30_000
/** 重连间隔：从 1 秒起逐步退避到 8 秒，避免服务抖动时被客户端打爆 */
const RECONNECT_MIN = 1_000
const RECONNECT_MAX = 8_000

/**
 * 建立对局 WebSocket。
 *
 * 断线后会自动用同一个 token 重连，网络闪断或后端重启都能自行恢复；
 * 只有前端主动调用 close() 才彻底停止。
 */
export function createGameSocket(
  code: string,
  token: string,
  handlers: GameSocketHandlers,
): GameSocket {
  const url = `${wsBaseUrl()}/ws/game?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`

  let socket: WebSocket | null = null
  let heartbeat: number | undefined
  let reconnectTimer: number | undefined
  let closedByUser = false
  let delay = RECONNECT_MIN
  /** 当前这次连接是不是从断线中恢复的 */
  let reconnected = false

  function stopHeartbeat(): void {
    window.clearInterval(heartbeat)
    heartbeat = undefined
  }

  function startHeartbeat(target: WebSocket): void {
    stopHeartbeat()
    heartbeat = window.setInterval(() => {
      if (target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'ping' }))
      }
    }, HEARTBEAT_INTERVAL)
  }

  function open(): void {
    const ws = new WebSocket(url)
    socket = ws

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        handlers.onMessage(JSON.parse(event.data) as ServerMessage)
      } catch {
        // 忽略无法解析的消息
      }
    }

    ws.onopen = () => {
      delay = RECONNECT_MIN
      startHeartbeat(ws)
      // 只有从断线中恢复才需要通知；首次连接直接走正常流程
      if (reconnected) {
        reconnected = false
        handlers.onReconnect?.()
      }
    }

    ws.onerror = () => handlers.onError()

    ws.onclose = () => {
      stopHeartbeat()
      socket = null
      if (closedByUser) {
        return
      }
      handlers.onClose()
      reconnected = true
      window.clearTimeout(reconnectTimer)
      reconnectTimer = window.setTimeout(open, delay)
      delay = Math.min(delay * 2, RECONNECT_MAX)
    }
  }

  open()

  return {
    send(type, payload) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type, payload }))
      }
    },
    close() {
      closedByUser = true
      window.clearTimeout(reconnectTimer)
      stopHeartbeat()
      socket?.close()
      socket = null
    },
  }
}
