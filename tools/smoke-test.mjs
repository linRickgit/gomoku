/**
 * 联调冒烟测试：建房 -> 加入 -> 对局 -> 胜负判定 -> 再来一局 -> 悔棋 -> 认输 -> 观战
 *
 * 前置条件：后端已启动在 http://localhost:8080
 * 运行：node tools/smoke-test.mjs
 */

const API = process.env.API_BASE ?? 'http://localhost:8080/api'
const WS_BASE = process.env.WS_BASE ?? 'ws://localhost:8080'

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
  if (!response.ok) {
    throw new Error(`${path} 返回 ${response.status}: ${text}`)
  }
  return JSON.parse(text)
}

async function get(path) {
  const response = await fetch(API + path)
  if (!response.ok) {
    throw new Error(`${path} 返回 ${response.status}`)
  }
  return response.json()
}

class Client {
  constructor(name) {
    this.name = name
    this.messages = []
    this.state = null
    this.welcome = null
  }

  connect(code, token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/ws/game?code=${code}&token=${token}`)
      this.ws = ws
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data)
        this.messages.push(message)
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

  async waitForWelcome() {
    return this.waitFor(() => this.welcome !== null, `${this.name} 等待 welcome`)
  }

  async waitForState(predicate, description) {
    return this.waitFor(() => this.state !== null && predicate(this.state), description)
  }

  async waitFor(predicate, description, timeout = 4000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (predicate()) return true
      await sleep(40)
    }
    throw new Error(`超时：${description}`)
  }

  lastError() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].type === 'error') return this.messages[i].payload
    }
    return null
  }

  clearErrors() {
    this.messages = this.messages.filter((m) => m.type !== 'error')
  }

  close() {
    this.ws?.close()
  }
}

async function main() {
  console.log('\n[1] 建房与加入（昵称随机分配）')
  const host = await post('/rooms')
  check('返回 6 位数字房间码', /^\d{6}$/.test(host.code), host.code)
  check('房主座位为 0', host.seat === 0)
  check('返回连接凭证', typeof host.token === 'string' && host.token.length > 0)
  check('房主拿到随机昵称', typeof host.nickname === 'string' && host.nickname.length > 0, host.nickname)

  const peek = await get(`/rooms/${host.code}`)
  check('房间可查询且状态为 WAITING', peek.status === 'WAITING', peek.status)

  const guest = await post(`/rooms/${host.code}/join`)
  check('对手座位为 1', guest.seat === 1)
  check('双方拿到同一个房间码', guest.code === host.code)
  check('对手拿到随机昵称', typeof guest.nickname === 'string' && guest.nickname.length > 0, guest.nickname)

  console.log('\n[2] WebSocket 握手')
  const alice = new Client('房主')
  const bob = new Client('挑战者')
  await alice.connect(host.code, host.token)
  await bob.connect(guest.code, guest.token)
  await alice.waitForWelcome()
  await bob.waitForWelcome()
  check('房主收到 welcome 且座位为 0', alice.welcome.seat === 0)
  check('对手收到 welcome 且座位为 1', bob.welcome.seat === 1)
  check('非观战身份', alice.welcome.spectator === false && bob.welcome.spectator === false)

  await alice.waitForState((s) => s.status === 'PLAYING', '等待房间进入 PLAYING')
  check('双方到齐后状态变为 PLAYING', alice.state.status === 'PLAYING')
  check('房主执黑先行（turn = 0）', alice.state.turn === 0)

  console.log('\n[3] 轮次校验')
  bob.clearErrors()
  bob.send('move', { row: 0, col: 0 })
  await sleep(300)
  check('非当前回合落子被拒绝', bob.lastError() !== null, JSON.stringify(bob.lastError()))

  alice.clearErrors()
  alice.send('move', { row: 7, col: 5 })
  await alice.waitForState((s) => s.moveCount === 1, '等待第一手广播')
  check('落子成功后回合交给对手', alice.state.turn === 1)
  check('最后一手被记录', Array.isArray(alice.state.lastMove) && alice.state.lastMove[1] === 5)

  console.log('\n[4] 重复落子校验')
  bob.clearErrors()
  bob.send('move', { row: 7, col: 5 })
  await sleep(300)
  check('重复位置落子被拒绝', bob.lastError() !== null)

  console.log('\n[5] 走完一局（黑棋横向连五）')
  const blackMoves = [
    [7, 6],
    [7, 7],
    [7, 8],
    [7, 9],
  ]
  const whiteMoves = [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
  ]

  for (let i = 0; i < blackMoves.length; i++) {
    bob.send('move', { row: whiteMoves[i][0], col: whiteMoves[i][1] })
    await alice.waitForState((s) => s.turn === 0, `等待黑棋回合 ${i}`)
    alice.send('move', { row: blackMoves[i][0], col: blackMoves[i][1] })
    await alice.waitForState((s) => s.turn === 1 || s.status === 'FINISHED', `等待黑棋落子 ${i}`)
  }

  await alice.waitForState((s) => s.status === 'FINISHED', '等待对局结束')
  check('黑棋五连后对局结束', alice.state.status === 'FINISHED')
  check('获胜方为座位 0（黑棋）', alice.state.winnerSeat === 0, String(alice.state.winnerSeat))
  check('结束原因为 FIVE_IN_ROW', alice.state.endReason === 'FIVE_IN_ROW', alice.state.endReason)
  check('返回了 5 个连珠坐标', alice.state.winLine.length === 5, String(alice.state.winLine.length))
  await bob.waitForState((s) => s.status === 'FINISHED', '对手端也收到结束状态')
  check('结果同步给了对手', bob.state.winnerSeat === 0)

  console.log('\n[6] 再来一局')
  alice.send('rematch')
  await sleep(200)
  check('单方申请时不重置棋盘', alice.state.status === 'FINISHED')
  bob.send('rematch')
  await alice.waitForState((s) => s.status === 'PLAYING', '等待双方同意后重开')
  check('双方同意后棋盘重置', alice.state.moveCount === 0)
  check('重开后仍由房主先行', alice.state.turn === 0)

  console.log('\n[7] 悔棋（需对方同意）')
  alice.send('move', { row: 7, col: 7 })
  await alice.waitForState((s) => s.moveCount === 1, '黑棋落子')
  bob.send('move', { row: 2, col: 2 })
  await alice.waitForState((s) => s.moveCount === 2, '白棋落子')

  alice.send('undo_request')
  await alice.waitForState((s) => s.undoRequestFrom === 0, '等待悔棋请求广播')
  check('悔棋请求被广播', alice.state.undoRequestFrom === 0)
  await bob.waitForState((s) => s.undoRequestFrom === 0, '对手收到悔棋请求')
  check('对手能看到悔棋请求', bob.state.undoRequestFrom === 0)

  bob.send('undo_response', { agree: true })
  await alice.waitForState((s) => s.undoRequestFrom === null && s.moveCount === 0, '等待悔棋生效')
  check('同意后棋盘回退两手', alice.state.moveCount === 0, String(alice.state.moveCount))
  check('悔棋后轮到请求方落子', alice.state.turn === 0, String(alice.state.turn))
  check('悔棋请求已清空', alice.state.undoRequestFrom === null)

  console.log('\n[8] 悔棋被拒绝')
  alice.send('move', { row: 7, col: 7 })
  await alice.waitForState((s) => s.moveCount === 1, '黑棋落子')
  bob.send('move', { row: 2, col: 2 })
  await alice.waitForState((s) => s.moveCount === 2, '白棋落子')
  alice.send('undo_request')
  await alice.waitForState((s) => s.undoRequestFrom === 0, '等待悔棋请求')
  bob.send('undo_response', { agree: false })
  await alice.waitForState((s) => s.undoRequestFrom === null, '等待拒绝生效')
  check('拒绝后棋盘不变', alice.state.moveCount === 2, String(alice.state.moveCount))
  check('拒绝后回合不变', alice.state.turn === 0)

  console.log('\n[9] 认输')
  alice.send('resign')
  await bob.waitForState((s) => s.status === 'FINISHED', '等待认输生效')
  check('认输后对局结束', bob.state.status === 'FINISHED')
  check('认输方为座位 0，对手获胜', bob.state.winnerSeat === 1, String(bob.state.winnerSeat))
  check('结束原因为 RESIGN', bob.state.endReason === 'RESIGN', bob.state.endReason)

  console.log('\n[10] 断线重连：带凭证回到原座位')
  const rHost = await post('/rooms')
  const rGuest = await post(`/rooms/${rHost.code}/join`)
  const ra = new Client('重连房主')
  const rb = new Client('重连对手')
  await ra.connect(rHost.code, rHost.token)
  await rb.connect(rGuest.code, rGuest.token)
  await ra.waitForState((s) => s.status === 'PLAYING', '等待新房间开局')

  ra.send('move', { row: 7, col: 7 })
  await ra.waitForState((s) => s.moveCount === 1, '重连用例：黑棋落子')
  rb.send('move', { row: 8, col: 8 })
  await ra.waitForState((s) => s.moveCount === 2, '重连用例：白棋落子')

  // 模拟刷新页面：断开 WebSocket，再凭原凭证重新进入。
  // 注意这里刻意选在掉线保护期（默认 5 秒）内，验证本人凭证不受保护期限制
  ra.close()
  await sleep(300)

  const rejoined = await post(`/rooms/${rHost.code}/join`, { token: rHost.token })
  check('掉线保护期内本人仍能坐回 seat 0', rejoined.seat === 0, String(rejoined.seat))
  check('重连沿用原昵称', rejoined.nickname === rHost.nickname, `${rejoined.nickname} / ${rHost.nickname}`)
  check('重连沿用原凭证', rejoined.token === rHost.token)

  const ra2 = new Client('重连后的房主')
  await ra2.connect(rejoined.code, rejoined.token)
  await ra2.waitForWelcome()
  check('重连后 welcome 仍为座位 0', ra2.welcome.seat === 0)
  check('重连后不是观战身份', ra2.welcome.spectator === false)

  await ra2.waitForState((s) => s.moveCount === 2, '重连后收到完整棋盘')
  check('重连后棋盘进度保留', ra2.state.moveCount === 2, String(ra2.state.moveCount))
  check('重连后回合不变', ra2.state.turn === 0, String(ra2.state.turn))

  await rb.waitForState((s) => s.players[0]?.online === true, '对手看到房主重新上线')
  check('重连后对手看到房主在线', rb.state.players[0].online === true)

  ra2.send('move', { row: 6, col: 6 })
  await rb.waitForState((s) => s.moveCount === 3, '重连后继续落子')
  check('重连后可以继续落子', rb.state.moveCount === 3, String(rb.state.moveCount))

  const stranger = await post(`/rooms/${rHost.code}/join`)
  check('双方都在线时无凭证进入只能观战', stranger.seat === -1, String(stranger.seat))

  ra2.close()
  rb.close()

  console.log('\n[11] 第三人进入即观战')
  const third = await post(`/rooms/${host.code}/join`)
  check('第三人进入成功且座位为 -1', third.seat === -1, String(third.seat))

  const carol = new Client('观战者')
  await carol.connect(third.code, third.token)
  await carol.waitForWelcome()
  check('观战者收到 welcome 且标记为观战', carol.welcome.spectator === true)
  await carol.waitForState((s) => s.code === host.code, '观战者收到房间状态')
  check('观战者能收到棋盘状态', carol.state !== null)

  const peekAfter = await get(`/rooms/${host.code}`)
  check('观战人数被统计', peekAfter.spectatorCount === 1, String(peekAfter.spectatorCount))

  carol.clearErrors()
  carol.send('move', { row: 5, col: 5 })
  await sleep(300)
  check('观战者落子被拒绝', carol.lastError() !== null, JSON.stringify(carol.lastError()))

  carol.clearErrors()
  carol.send('resign')
  await sleep(300)
  check('观战者认输被拒绝', carol.lastError() !== null)

  console.log('\n[12] 掉线后的座位保护期与释放')
  const dHost = await post('/rooms')
  const dGuest = await post(`/rooms/${dHost.code}/join`)
  const da = new Client('掉线房主')
  const db = new Client('在线对手')
  await da.connect(dHost.code, dHost.token)
  await db.connect(dGuest.code, dGuest.token)
  await da.waitForState((s) => s.status === 'PLAYING', '等待开局')
  da.send('move', { row: 7, col: 7 })
  await da.waitForState((s) => s.moveCount === 1, '黑棋落子')
  db.send('move', { row: 0, col: 0 })
  await da.waitForState((s) => s.moveCount === 2, '白棋落子')

  // 房主掉线：保护期内座位仍为他保留，避免网络抖动一断线就被路人抢走
  da.close()
  await sleep(300)

  const early = await post(`/rooms/${dHost.code}/join`)
  check('掉线保护期内新人只能观战', early.seat === -1, String(early.seat))

  const earlyClaim = await post(`/rooms/${dHost.code}/seat`, { token: early.token })
  check('保护期内观战者补位同样被拒', earlyClaim.seat === -1, String(earlyClaim.seat))

  // 保护期过后（默认 5 秒），观战者可以自动入座，不需要重新输入房间码
  await sleep(5200)
  const newcomer = await post(`/rooms/${dHost.code}/seat`, { token: early.token })
  check('保护期过后观战者自动入座', newcomer.seat === 0, String(newcomer.seat))
  check('沿用原座位昵称，对手视角不突兀', newcomer.nickname === dHost.nickname, `${newcomer.nickname} / ${dHost.nickname}`)

  const dc = new Client('接替者')
  await dc.connect(newcomer.code, newcomer.token)
  await dc.waitForWelcome()
  check('接替者 welcome 座位为 0', dc.welcome.seat === 0)
  await dc.waitForState((s) => s.moveCount === 2, '接替后拿到原棋盘')
  check('棋盘进度保留', dc.state.moveCount === 2, String(dc.state.moveCount))
  check('轮次未被打乱', dc.state.turn === 0, String(dc.state.turn))

  await db.waitForState((s) => s.players[0]?.online === true, '对手看到新玩家上线')
  check('对手看到座位重新有人', db.state.players[0].online === true)
  dc.send('move', { row: 6, col: 6 })
  await db.waitForState((s) => s.moveCount === 3, '接替者落子')
  check('接替者能正常落子', db.state.moveCount === 3, String(db.state.moveCount))

  const late = await post(`/rooms/${dHost.code}/join`, { token: dHost.token })
  check('两个座位都有人在线时只能观战', late.seat === -1, String(late.seat))
  dc.close()
  db.close()

  console.log('\n[13] 互换阵营')
  const sHost = await post('/rooms')
  const sGuest = await post(`/rooms/${sHost.code}/join`)
  const sa = new Client('换阵房主')
  const sb = new Client('换阵对手')
  await sa.connect(sHost.code, sHost.token)
  await sb.connect(sGuest.code, sGuest.token)
  await sa.waitForState((s) => s.status === 'PLAYING', '等待开局')

  sa.send('move', { row: 7, col: 7 })
  await sa.waitForState((s) => s.moveCount === 1, '黑棋落子')
  sb.send('move', { row: 0, col: 0 })
  await sa.waitForState((s) => s.moveCount === 2, '白棋落子')
  check('交换前 (7,7) 是黑棋', sa.state.board[7][7] === 1, String(sa.state.board[7][7]))
  check('交换前 (0,0) 是白棋', sa.state.board[0][0] === 2, String(sa.state.board[0][0]))

  sa.send('swap_request')
  await sa.waitForState((s) => s.swapRequestFrom === 0, '等待换阵请求广播')
  check('换阵请求被广播', sa.state.swapRequestFrom === 0)
  await sb.waitForState((s) => s.swapRequestFrom === 0, '对手收到换阵请求')
  check('对手能看到换阵请求', sb.state.swapRequestFrom === 0)

  sb.send('swap_response', { agree: true })
  await sa.waitForState((s) => s.swapRequestFrom === null && s.turn === 1, '等待换阵生效')
  check('棋盘黑白翻转：(7,7) 变白棋', sa.state.board[7][7] === 2, String(sa.state.board[7][7]))
  check('棋盘黑白翻转：(0,0) 变黑棋', sa.state.board[0][0] === 1, String(sa.state.board[0][0]))
  check('历史落子数不变', sa.state.moveCount === 2, String(sa.state.moveCount))
  check('回合随之翻转', sa.state.turn === 1, String(sa.state.turn))
  check('座位持有者互换', sa.state.players[0].nickname === sGuest.nickname, sa.state.players[0].nickname)
  check('对手端也看到互换', sb.state.players[1].nickname === sHost.nickname, sb.state.players[1].nickname)

  const saSeat = sa.state.players.findIndex((p) => p && p.isSelf === true)
  const sbSeat = sb.state.players.findIndex((p) => p && p.isSelf === true)
  check('房主端 isSelf 变为座位 1', saSeat === 1, String(saSeat))
  check('对手端 isSelf 变为座位 0', sbSeat === 0, String(sbSeat))

  // 交换后轮到座位 1（原房主），他能落子且棋子颜色应为白
  sa.send('move', { row: 3, col: 3 })
  await sb.waitForState((s) => s.moveCount === 3, '交换后原房主落子')
  check('交换后原房主能落子', sb.state.moveCount === 3, String(sb.state.moveCount))
  check('交换后原房主持白棋', sb.state.board[3][3] === 2, String(sb.state.board[3][3]))

  console.log('\n[14] 互换阵营被拒绝')
  // 上一轮交换后，sb 已经坐到座位 0 了
  const sbNowSeat = sb.state.players.findIndex((p) => p && p.isSelf === true)
  sb.send('swap_request')
  await sa.waitForState((s) => s.swapRequestFrom === sbNowSeat, '等待换阵请求')
  check('对手也能发起换阵请求', sa.state.swapRequestFrom === sbNowSeat, String(sa.state.swapRequestFrom))
  sa.send('swap_response', { agree: false })
  await sb.waitForState((s) => s.swapRequestFrom === null, '等待拒绝生效')
  check('拒绝后请求清空', sb.state.swapRequestFrom === null)
  check('拒绝后棋盘不变', sb.state.board[7][7] === 2, String(sb.state.board[7][7]))
  check('拒绝后回合不变', sb.state.turn === 0, String(sb.state.turn))
  sa.close()
  sb.close()

  console.log('\n[15] 主动离开：座位立即释放，不进入保护期')
  const lHost = await post('/rooms')
  const lGuest = await post(`/rooms/${lHost.code}/join`)
  const la = new Client('主动离开者')
  const lb = new Client('留下来的对手')
  await la.connect(lHost.code, lHost.token)
  await lb.connect(lGuest.code, lGuest.token)
  await la.waitForState((s) => s.status === 'PLAYING', '等待开局')
  la.send('move', { row: 7, col: 7 })
  await la.waitForState((s) => s.moveCount === 1, '黑棋落子')

  // 与 [12] 形成对照：同样是断开后 300ms 就有人进来，
  // 掉线会被保护期挡住（观战），主动离开则立刻可以坐下
  await post(`/rooms/${lHost.code}/leave`, { token: lHost.token })
  await sleep(300)

  const afterLeave = await post(`/rooms/${lHost.code}/join`)
  check('主动离开后座位立即对外开放', afterLeave.seat === 0, String(afterLeave.seat))
  check('沿用原座位昵称', afterLeave.nickname === lHost.nickname, `${afterLeave.nickname} / ${lHost.nickname}`)

  const lc = new Client('接替主动离开者')
  await lc.connect(afterLeave.code, afterLeave.token)
  await lc.waitForWelcome()
  check('接替者 welcome 座位为 0', lc.welcome.seat === 0)
  await lc.waitForState((s) => s.moveCount === 1, '接替后拿到原棋盘')
  check('棋盘进度保留', lc.state.moveCount === 1, String(lc.state.moveCount))

  // 接替者自己掉线时仍享有保护期 —— departed 标记不能污染下一个人
  lc.close()
  await sleep(300)
  const afterNewDrop = await post(`/rooms/${lHost.code}/join`)
  check('接替者掉线后重新享有保护期', afterNewDrop.seat === -1, String(afterNewDrop.seat))

  la.close()
  lb.close()

  console.log('\n[16] 房间码校验')
  try {
    await get('/rooms/000000')
    check('不存在的房间返回错误', false, '竟然查询成功')
  } catch {
    check('不存在的房间返回错误', true)
  }

  try {
    await post('/rooms/abc/join')
    check('非法房间码被拒绝', false, '竟然加入成功')
  } catch {
    check('非法房间码被拒绝', true)
  }

  alice.close()
  bob.close()
  carol.close()

  console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('\n冒烟测试异常中断：', error.message)
  process.exit(1)
})
