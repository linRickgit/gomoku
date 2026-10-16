/**
 * 联机会话的本地留存。
 *
 * 玩家刷新页面、误关标签页后重新进入时，需要靠这里保存的 token 向服务端
 * 证明"我就是刚才坐在那个座位上的人"，否则会被当成新人分配的观战席。
 *
 * 用 sessionStorage 而非 localStorage：同一个浏览器开两个标签页各占一个座位时
 * 互不影响，关掉标签页即失效，不会把座位凭证长期留在机器上。
 */

const KEY = 'gomoku.room'

export interface RoomSession {
  code: string
  seat: number
  token: string
  nickname: string
}

export function saveRoom(session: RoomSession): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(session))
  } catch {
    // 隐私模式下写入会失败，降级为不记住，不影响正常对局
  }
}

export function loadRoom(): RoomSession | null {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RoomSession>
    if (typeof parsed.code !== 'string' || typeof parsed.token !== 'string') {
      return null
    }
    return {
      code: parsed.code,
      seat: typeof parsed.seat === 'number' ? parsed.seat : -1,
      token: parsed.token,
      nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
    }
  } catch {
    return null
  }
}

export function clearRoom(): void {
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    // 同上，忽略写入失败
  }
}
