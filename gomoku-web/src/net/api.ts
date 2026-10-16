export interface JoinResponse {
  code: string
  seat: number
  token: string
  nickname: string
}

export interface ApiErrorBody {
  errorCode: string
  message: string
}

/**
 * 后端基础地址（代理/域名根路径，不含 /api）。
 * - 不设置：走相对路径，前后端同源（开发期 Vite 代理、或一起打进 Spring Boot 时）；
 * - 设置示例：`VITE_BASE=http://kshome.sckje.com/gomoku`，
 *   则 HTTP 接口为 http://kshome.sckje.com/gomoku/api/...，
 *   让前端去访问经反向代理（/gomoku 前缀）后端的独立部署地址。
 */
const RAW_BASE = import.meta.env.VITE_BASE as string | undefined
const BASE = RAW_BASE ? RAW_BASE.replace(/\/$/, '') : ''
const API_BASE = BASE ? `${BASE}/api` : '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    let message = `请求失败（${response.status}）`
    try {
      const body = (await response.json()) as ApiErrorBody
      if (body?.message) message = body.message
    } catch {
      // 响应体不是 JSON 时沿用默认提示
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

/** 建房。昵称由服务端随机分配 */
export function createRoom(): Promise<JoinResponse> {
  return request<JoinResponse>('/rooms', { method: 'POST', body: '{}' })
}

/**
 * 凭房间码进入。
 *
 * 带上上次进入时拿到的 token，服务端会据此把人放回原来的座位（刷新页面、
 * 断线重连都靠它）；没有 token 则按「对手位空缺 → 接管离线座位 → 观战」分配。
 */
export function joinRoom(code: string, token?: string | null): Promise<JoinResponse> {
  return request<JoinResponse>(`/rooms/${encodeURIComponent(code)}/join`, {
    method: 'POST',
    body: JSON.stringify(token ? { token } : {}),
  })
}

/**
 * 观战者尝试入座。
 *
 * 进来时若恰好撞上对方掉线的保护期（默认 5 秒），会先被安排为观战。
 * 用观战凭证周期性调用本接口，保护期一过就能自动坐上；seat 仍为 -1 表示还没位子。
 */
export function claimSeat(code: string, token: string): Promise<JoinResponse> {
  return request<JoinResponse>(`/rooms/${encodeURIComponent(code)}/seat`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

/**
 * 主动离开房间。
 *
 * 与直接关页面的区别：座位立即释放，不进入掉线保护期，别人可以马上进来接着下。
 */
export function leaveRoom(code: string, token: string): Promise<{ left: boolean }> {
  return request<{ left: boolean }>(`/rooms/${encodeURIComponent(code)}/leave`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

export function peekRoom(code: string): Promise<{
  code: string
  status: string
  playerCount: number
  spectatorCount: number
}> {
  return request(`/rooms/${encodeURIComponent(code)}`)
}
