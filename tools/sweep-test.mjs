/**
 * 房间回收测试：验证"双方都掉线后棋盘保留一段时间"的巡检逻辑。
 *
 * 真实配置是 10 分钟，等不起；这里拉起临时实例把保留时长压到 0、
 * 巡检间隔压到 1 秒，几秒内就能跑完。
 *
 * 运行：node tools/sweep-test.mjs
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PORT = 8082
const API = `http://localhost:${PORT}/api`
const WS_BASE = `ws://localhost:${PORT}`
const JAR = fileURLToPath(new URL('../gomoku-server/target/gomoku-server.jar', import.meta.url))
const JAVA = 'C:/Program Files/Java/jdk-21/bin/java.exe'

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function post(path, body = {}) {
  const response = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} 返回 ${response.status}: ${text}`)
  return JSON.parse(text)
}

async function get(path) {
  const response = await fetch(API + path)
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) }
}

class Client {
  constructor(name) {
    this.name = name
    this.state = null
    this.welcome = null
  }

  connect(code, token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/ws/game?code=${code}&token=${token}`)
      this.ws = ws
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.type === 'room_state') this.state = message.payload
        if (message.type === 'welcome') this.welcome = message.payload
      }
      ws.onopen = () => resolve()
      ws.onerror = (error) => reject(error)
      setTimeout(() => reject(new Error(`${this.name} 连接超时`)), 5000)
    })
  }

  send(type, payload) {
    this.ws.send(JSON.stringify({ type, payload }))
  }

  async waitFor(predicate, description, timeout = 4000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (predicate()) return true
      await sleep(40)
    }
    throw new Error(`超时：${description}`)
  }

  async waitForState(predicate, description) {
    return this.waitFor(() => this.state !== null && predicate(this.state), description)
  }

  close() {
    this.ws?.close()
  }
}

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`${API}/rooms/stats`)
      if (response.ok) return true
    } catch {
      // 还没起来
    }
    await sleep(500)
  }
  throw new Error('临时实例启动超时')
}

async function main() {
  const env = { ...process.env }
  delete env.SERVER__PORT

  console.log(`\n拉起临时实例 :${PORT}（保留时长 0 分钟，巡检间隔 1 秒）`)
  const child = spawn(
    JAVA,
    [
      '-jar', JAR,
      `--server.port=${PORT}`,
      '--gomoku.room.abandoned-timeout-minutes=0',
      '--gomoku.sweep-interval-millis=1000',
      '--gomoku.sweep-initial-delay-millis=1000',
      '--spring.main.banner-mode=off',
    ],
    { env, stdio: 'ignore' },
  )

  try {
    await waitReady()

    console.log('\n[1] 双方都掉线后，房间会被巡检回收')
    const a = await post('/rooms')
    const b = await post(`/rooms/${a.code}/join`)
    const ca = new Client('甲')
    const cb = new Client('乙')
    await ca.connect(a.code, a.token)
    await cb.connect(b.code, b.token)
    await ca.waitForState((s) => s.status === 'PLAYING', '等待开局')
    ca.send('move', { row: 7, col: 7 })
    await ca.waitForState((s) => s.moveCount === 1, '落子')

    // 房间还活着
    const alive = await get(`/rooms/${a.code}`)
    check('对局中房间可查询', alive.ok, String(alive.status))

    ca.close()
    cb.close()
    await sleep(3000)

    // 房间被销毁后查询会返回业务错误（400 ROOM_NOT_FOUND），而不是 200
    const gone = await get(`/rooms/${a.code}`)
    check('双方掉线且超过保留时长后房间被回收', !gone.ok, `HTTP ${gone.status}`)

    console.log('\n[2] 还有玩家在线时不会被回收')
    const c = await post('/rooms')
    const d = await post(`/rooms/${c.code}/join`)
    const cc = new Client('丙')
    const cd = new Client('丁')
    await cc.connect(c.code, c.token)
    await cd.connect(d.code, d.token)
    await cc.waitForState((s) => s.status === 'PLAYING', '等待开局')

    // 只掉线一人
    cd.close()
    await sleep(3000)
    const stillThere = await get(`/rooms/${c.code}`)
    check('仍有一方在线时房间保留', stillThere.ok, `HTTP ${stillThere.status}`)

    // 两人都在时也不会被回收
    await sleep(2000)
    const stillThere2 = await get(`/rooms/${c.code}`)
    check('在线对局不会被巡检打断', stillThere2.ok, `HTTP ${stillThere2.status}`)

    cc.close()
  } finally {
    child.kill()
  }

  console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('\n回收测试异常中断：', error.message)
  process.exit(1)
})
