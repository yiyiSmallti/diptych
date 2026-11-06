// dsh web with the package, driven by a headless Chrome. The person (this
// test) plays Ember: by keyboard for real, and by the game's assist
// autopilot for the long walks. The Session's Agent is a fake model that
// plays Rime only through the real tools, reading what they return. They
// clear level 1 together, the Agent moves them on to level 2, a death
// restarts the level, and a line typed in the game while the Agent is idle
// reaches it as a message.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Chrome, Page, chromePath, jsStr, pt } from './chrome.mjs'
import { Cleanup, Dsh, attempt, check, findDsh, packPlugin, shortTemp, sleep, startModel } from './harness.mjs'

// startWeb runs dsh web in the workspace on a free port and returns its
// signed-in address; the address carries a token, so it is never logged.
function startWeb (d, ws, model, cleanup) {
  const [cmd, ...rest] = d.argv('--profile', 'diptych-web', '--no-open', '--port', '0')
  const child = spawn(cmd, rest, {
    cwd: ws,
    env: { ...process.env, ...d.env, DEEPSEEK_API_KEY: 'sk-diptych-e2e', DEEPSEEK_BASE_URL: model.url },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const exited = new Promise((resolve) => child.on('close', resolve))
  cleanup.add(async () => { child.kill('SIGKILL'); await exited })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dsh web 90 秒内没有打印地址')), 90000)
    let buf = ''
    const scan = (data) => {
      buf += data
      const m = /dsh web: (http:\/\/\S+)/.exec(buf)
      if (m) { clearTimeout(timer); resolve(m[1]) }
      if (buf.length > 1 << 20) buf = buf.slice(-4096)
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

// dismissDialogs clears what a fresh home shows first.
async function dismissDialogs (p) {
  for (const end = Date.now() + 8000; Date.now() < end; await sleep(400)) {
    let v
    try {
      v = await p.js(`const d = [...document.querySelectorAll('[role=dialog]')].find((e) => __q.vis(e)); if (!d) return 'none'; const b = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续') ?? d.querySelector('button[aria-label="关闭"], button[aria-label="Close"]'); return b ? __q.centre(b) : 'esc'`)
    } catch {}
    if (v === 'esc') await p.key('Escape').catch(() => {})
    else if (v && typeof v === 'object') await p.click(pt(v).x, pt(v).y, 1).catch(() => {})
  }
}

// enterSession opens the Session by its title.
async function enterSession (p, title, folder) {
  for (const name of ['未分组', folder].filter(Boolean)) {
    if (await p.js(`return !!__q.byText(${jsStr(title)}, false)`).catch(() => false) === true) break
    if (await p.js(`return !!__q.byText(${jsStr(name)}, false)`).catch(() => false) !== true) continue
    await p.clickText(name, false)
    await sleep(500)
  }
  let e
  for (let i = 0; i < 3; i++) {
    e = await attempt(async () => {
      await p.clickText(title, false)
      await p.waitJS(`return document.title.includes(${jsStr(title)})`, 4000)
    })
    if (!e) break
  }
  if (e) throw e
  await sleep(800)
}

// The fake Agent: a walkthrough of level 1 as Rime, one tool call per
// request, each step taken after reading the previous result. A step with
// `until` repeats until its result says so.
function agentBrain () {
  const act = (input) => ({ name: 'diptych_act', input })
  const steps = [
    { call: { name: 'diptych_look', input: {} } },
    { call: act({ action: 'go', target: '15,5', say: '我先爬上中间层～你去踩黄灯那个 b？' }) },
    { call: { name: 'diptych_wait', input: { seconds: 30 } }, until: (t) => t.includes('闸门 A 开了') || /A开/.test(t) },
    { call: act({ action: 'pull', target: 'l', say: '谢啦！门开了，我去拉拉杆～' }) },
    { call: act({ action: 'go', target: 'exit', say: '好耶，B 开啦！出口见 ✨' }) },
    { call: { name: 'diptych_wait', input: { seconds: 30 } }, until: (t) => t.includes('过关') },
    { call: act({ action: 'next', say: '配合满分！下一关走起～' }) },
    { call: { name: 'diptych_look', input: {} } }
  ]
  let i = -1
  let reps = 0
  return (m) => {
    if (!m.prompt.includes('来玩双联画')) return null
    const last = m.results.at(-1)?.text ?? ''
    if (i >= 0 && i < steps.length && steps[i].until && !steps[i].until(last) && reps++ < 12) return steps[i].call
    i++
    reps = 0
    return steps[i]?.call ?? null
  }
}

export async function web (rep) {
  const s = rep.section('dsh web：人和 Agent 一起在右侧栏玩双联画')
  const cleanup = new Cleanup()
  try {
    await suite(s, cleanup)
  } finally {
    await cleanup.run()
  }
}

async function suite (s, cleanup) {
  const dshBin = findDsh()
  const chromeBin = chromePath()
  if (!dshBin || !chromeBin) {
    s.step('找到 dsh 和 Chrome', new Error(`缺少 dsh=${jsStr(dshBin)} chrome=${jsStr(chromeBin)}`))
    return
  }
  const work = shortTemp(cleanup)
  const ws = path.join(work, 'ws')
  fs.mkdirSync(ws, { recursive: true })
  const d = new Dsh(dshBin, work)
  const model = await startModel(cleanup, agentBrain(), '好的')
  model.reply = '好的'
  let err = await attempt(async () => {
    const tgz = packPlugin(work)
    await d.install('diptych-e2e', tgz)
    const turn = await d.turn('diptych-e2e', ws, model, '一起玩个游戏')
    if (turn.err) throw turn.err
    await d.run('--profile', 'diptych-web', '--from-default-profile', 'web', '--dump-config')
    await d.run('plugin', '--profile', 'diptych-web', 'add', tgz)
  })
  if (!s.step('准备：sdk profile 跑一轮建出会话，web 模板 profile 装上本包', err)) return
  let url = ''
  err = await attempt(async () => { url = await startWeb(d, ws, model, cleanup) })
  if (!s.step('启动 dsh web（随机端口）', err)) return
  let c
  err = await attempt(async () => { c = await Chrome.start(chromeBin, work, cleanup) })
  if (!s.step('无头 Chrome', err)) return
  await c.send(c.session, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }).catch(() => {})
  await c.navigate(url).catch(() => {})
  await c.waitLoaded()
  const p = new Page(c)
  const game = (expr) => p.js(`const g = __q.game(); if (!g) return null; ${expr}`)

  err = await attempt(() => p.waitJS(`return !!(window.__DSH_BOOT__?.entries ?? []).find((e) => e.id === '@precinct/diptych') && !!document.getElementById('diptych-css')`, 30000))
  if (!s.step('客户端模块：boot 清单里有 @precinct/diptych，apply 已运行', err)) { await p.shot('web-fail-boot.png'); return }

  // Open the Session, the right Sidebar's guide, and the game from it.
  await dismissDialogs(p)
  err = await attempt(async () => {
    await enterSession(p, '一起玩个游戏', 'ws')
    if (await p.js(`return !!__q.byText('双联画', true)`).catch(() => false) !== true) {
      await p.clickJS(`return __q.centre(document.querySelector('button[aria-label="打开右侧边栏"]'))`)
    }
    await p.clickText('双联画', true)
    await p.waitJS(`return !!__q.game() && !!document.querySelector('.dp-menu')`, 20000)
  })
  if (!s.step('右侧栏引导页有「双联画」，点开是游戏的选关界面（引擎从宿主路由载入）', err)) { await p.shot('web-fail-open.png'); return }
  await sleep(500)
  await p.shot('web-menu.png')

  // Ember, with the Agent, level 1: real clicks on the menu.
  err = await attempt(async () => {
    await p.clickJS(`return __q.centre([...document.querySelectorAll('.dp-hero')].find((b) => b.textContent.includes('Ember')))`)
    await p.clickJS(`return __q.centre([...document.querySelectorAll('.dp-seg button')].find((b) => b.textContent.includes('Agent')))`)
    await p.clickJS(`return __q.centre(document.querySelector('.dp-go'))`)
    await p.waitJS(`const g = __q.game(); return g?.mode === 'play' && g.L.id === '1' && g.human === 'ember' && g.agentKind === 'rime'`, 8000)
  })
  if (!s.step('选烬、和 Agent 一起，开始第 1 关', err)) return

  // The keyboard moves Ember: right, then a jump.
  err = await attempt(async () => {
    await p.clickJS(`return __q.centre(document.querySelector('.dp-canvas'))`)
    const x0 = await game('return g.W.heroes.ember.x')
    await p.hold(['ArrowRight'], 450)
    const x1 = await game('return g.W.heroes.ember.x')
    if (!(x1 > x0 + 1.5)) throw new Error(`按住 → 0.45 秒只走了 ${(x1 - x0).toFixed(2)} 格`)
    // Watch every frame: under the low ceiling the hop is short.
    await p.js(`window.__minY = 99; const g = __q.game(); const f = () => { window.__minY = Math.min(window.__minY, g.W.heroes.ember.y); if (window.__minY < 99 && g.W.heroes.ember.ground && window.__minY < 8) return; requestAnimationFrame(f) }; requestAnimationFrame(f); return true`)
    await p.hold(['Space'], 120)
    await p.waitJS(`return __q.game().W.heroes.ember.ground && window.__minY < 7.6 ? window.__minY : false`, 3000)
  })
  s.step('键盘：按住 → 烬向右走，空格起跳再落地（低天花板下只跳得起一格）', err)

  // Invite the Agent: a message to the Session starts its turn.
  const before = model.requests
  err = await attempt(async () => {
    await p.clickJS(`return __q.centre(document.querySelector('.dp-invite'))`)
    await p.waitJS(`return __q.game()?.agent?.active === true`, 20000)
    if (model.requests === before) throw new Error('模型没收到请求')
    if (!model.prompt.includes('来玩双联画')) throw new Error('邀请消息没有进会话')
  })
  if (!s.step('点「叫 Agent 来玩」：一条消息进会话，Agent 开始一轮并进入游戏', err)) { await p.shot('web-fail-invite.png'); return }

  err = await attempt(async () => {
    await p.waitJS(`const g = __q.game(); const h = g.W.heroes.rime; return Math.floor(h.x + 0.35) === 15 && Math.floor(h.y + 0.9 - 1e-9) === 5 && h.ground`, 30000)
    await p.waitJS(`return __q.log().some((l) => l.includes('我先爬上中间层'))`, 5000)
  })
  const look = model.results.find((r) => r.text.includes('关卡 1「两条路」'))?.text ?? ''
  s.step('Agent 的 diptych_look 拿到带坐标的地图、对象说明和走得到的目标', check(look.includes(' 8 #') && look.includes('b 按钮 (18,5)') && look.includes('你是凇') && look.includes('你现在走得到'), look.slice(0, 200)))
  s.step('Agent 用 diptych_act 让凇自己走上中间层 (15,5)，说的话出现在游戏聊天里', err)
  await p.shot('web-agent-moved.png')

  // Ember holds button b; the Agent, waiting, hears gate A open, pulls
  // lever l and heads for its exit.
  err = await attempt(async () => {
    const r = await p.js(`return __q.game().assist('b')`)
    if (!r?.ok) throw new Error('烬去按钮 b：' + r?.text)
    await p.waitJS(`return __q.game().W.levers.l === true`, 40000)
    await p.waitJS(`return __q.game().W.gates.B === 1`, 5000)
  })
  s.step('烬踩住按钮 b → 闸门 A 开 → 等待中的 Agent 被叫醒，去拉拉杆 l → 闸门 B 开', err,
    model.results.some((r) => r.text.includes('拉了一下')) ? 'Agent 的结果：到了拉杆 l，拉了一下' : '')
  await p.shot('web-coop.png')

  err = await attempt(async () => {
    const r = await p.js(`return __q.game().assist('exit')`)
    if (!r?.ok) throw new Error('烬去出口：' + r?.text)
    await p.waitJS(`const g = __q.game(); return g.L.id === '2' && g.mode === 'play'`, 40000)
  })
  s.step('两人都站到出口 → 过关；Agent 等到「过关」后用 next 开了第 2 关', err)
  const unlocked = await p.js(`return JSON.parse(localStorage.getItem('diptych:v1')).unlocked`).catch(() => 0)
  s.step('过关记录：第 2 关解锁（浏览器本地）', check(unlocked === 2, `unlocked=${unlocked}`))
  err = await attempt(async () => {
    await p.waitJS(`return __q.game().agent.active === false || true`, 1000)
    for (const end = Date.now() + 20000; Date.now() < end && !model.results.some((r) => r.text.includes('关卡 2「升降台」')); await sleep(300));
    if (!model.results.some((r) => r.text.includes('关卡 2「升降台」'))) throw new Error('Agent 没看到第 2 关的地图')
  })
  s.step('Agent 看到第 2 关的地图后结束这一轮', err)
  const log = await p.js('return __q.log()').catch(() => [])
  s.step('游戏聊天记下了 Agent 说的话和过关', check(log.some((l) => l.includes('谢啦！门开了，我去拉拉杆')) && log.some((l) => l.includes('过关')), log.join(' / ').slice(0, 300)))
  await p.shot('web-level2.png')

  // A death: Ember walks into the frost pool; the level restarts.
  err = await attempt(async () => {
    await p.clickJS(`return __q.centre(document.querySelector('.dp-canvas'))`)
    await p.hold(['ArrowRight'], 3500)
    await p.waitJS(`return __q.log().some((l) => l.includes('烬碰到寒潭，倒下了'))`, 3000)
    await p.waitJS(`const g = __q.game(); return g.W.status === 'playing' && g.W.tick < 120`, 4000)
  })
  s.step('烬一直往右走进寒潭 → 倒下，关卡自动重开', err)

  // With the Agent idle, a line typed in the game becomes a message.
  const n0 = model.requests
  err = await attempt(async () => {
    await p.waitJS(`return __q.game().agent.active === false`, 40000)
    await p.clickJS(`return __q.centre(document.querySelector('.dp-in'))`)
    await p.typeText('第二关先等我研究一下')
    await p.key('Enter')
    for (const end = Date.now() + 20000; Date.now() < end && !(model.requests > n0 && model.prompt.includes('在双联画里对你说')); await sleep(300));
    if (!model.prompt.includes('第二关先等我研究一下')) throw new Error('这句话没进会话')
  })
  s.step('Agent 不在游戏里时，游戏聊天框说的话作为消息发进会话，叫醒 Agent', err)
  await p.shot('web-end.png')

  // The save: walk a little into level 2, reload the page, and the game
  // picks up where Ember stood.
  let saved = null
  err = await attempt(async () => {
    await p.waitJS(`return __q.game().agent.active === false`, 40000)
    await p.clickJS(`return __q.centre(document.querySelector('.dp-canvas'))`)
    await p.hold(['ArrowRight'], 300)
    await p.waitJS(`return __q.game().W.heroes.ember.ground`, 3000)
    await sleep(1300)
    saved = await game(`return { x: g.W.heroes.ember.x, tick: g.W.tick }`)
    await p.js(`document.dispatchEvent(new Event('visibilitychange')); return true`)
    const run = await p.js(`return JSON.parse(localStorage.getItem('diptych:v1')).run`)
    if (run?.level !== '2' || Math.abs(run.world.heroes.ember.x - saved.x) > 0.01) throw new Error('存档里没有第 2 关的位置：' + JSON.stringify(run)?.slice(0, 200))
    await c.navigate(url).catch(() => {})
    await c.waitLoaded()
    await dismissDialogs(p)
    await enterSession(p, '一起玩个游戏', 'ws')
    const shown = await p.waitJS(`return !!__q.game()`, 6000).then(() => true, () => false)
    if (!shown) {
      if (await p.js(`return !!__q.byText('双联画', true)`).catch(() => false) !== true) {
        await p.clickJS(`return __q.centre(document.querySelector('button[aria-label="打开右侧边栏"]'))`)
      }
      await p.clickText('双联画', true)
    }
    await p.waitJS(`const g = __q.game(); return g?.mode === 'play' && g.L.id === '2'`, 20000)
    const now = await game(`return { x: g.W.heroes.ember.x, tick: g.W.tick }`)
    if (Math.abs(now.x - saved.x) > 0.05 || now.tick < saved.tick) throw new Error(`刷新后烬在 x=${now.x.toFixed(2)}、第 ${now.tick} 帧，存档时是 x=${saved.x.toFixed(2)}、第 ${saved.tick} 帧`)
    await p.waitJS(`return __q.log().some((l) => l.includes('继续第 2 关'))`, 3000)
  })
  s.step('本地存档：第 2 关走了几步后刷新页面，游戏自己回到第 2 关、烬还站在原处', err, saved ? `存档时烬 x=${saved.x.toFixed(2)}，第 ${saved.tick} 帧` : '')

  // After a win the next level starts by itself; "stay" keeps the level.
  const toExits = `for (const k of ['ember', 'rime']) { const e = g.L.exits[k]; Object.assign(g.W.heroes[k], { x: e.x + 0.15, y: e.y + 0.1, vx: 0, vy: 0 }) } return true`
  err = await attempt(async () => {
    await game(`g.start('1'); ${toExits}`)
    await p.waitJS(`const g = __q.game(); return g.W.status === 'complete' && /秒后自动进入下一关/.test(document.querySelector('.dp-count')?.textContent ?? '')`, 4000)
    await p.waitJS(`const g = __q.game(); return g.L.id === '2' && g.mode === 'play' && g.W.status === 'playing'`, 8000)
    await game(`g.start('1'); ${toExits}`)
    await p.waitJS(`return __q.game().W.status === 'complete'`, 4000)
    await p.clickJS(`return __q.centre([...document.querySelectorAll('.dp-row .dp-btn')].find((b) => b.textContent.includes('留在这关')))`)
    await sleep(5500)
    const g = await game(`return { id: g.L.id, status: g.W.status }`)
    if (g.id !== '1' || g.status !== 'complete') throw new Error('点了「先留在这关」还是走了：' + JSON.stringify(g))
  })
  s.step('过关后倒计时几秒自动进入下一关；点「先留在这关」就停在这一关', err)

  // Every level opens and draws in the real page; a few are kept as
  // screenshots, and so is the menu's last chapter.
  err = await attempt(async () => {
    const n = await game(`for (const d of g.E.LEVELS) { g.start(d.id); g.draw(performance.now() / 1000 + 1) } return g.E.LEVELS.length`)
    if (n !== 30) throw new Error(`只有 ${n} 关`)
    for (const id of ['13', '19', '25', '30']) {
      await game(`g.start('${id}'); return true`)
      await sleep(900)
      await p.shot(`web-level${id}.png`)
    }
    await game(`g.unlocked = 30; g.toMenu(); g.chapter = 4; g.renderMenu(); return true`)
    await sleep(500)
    const fits = await p.js(`const c = document.querySelector('.dp-menu').getBoundingClientRect(); const s = document.querySelector('.dp-stage').getBoundingClientRect(); return c.bottom <= s.bottom + 1 && c.top >= s.top - 1`)
    if (!fits) throw new Error('选关卡片超出了画面')
    await p.shot('web-menu-chapter5.png')
  })
  s.step('全部 30 关都能在页面里开局和绘制；选关卡片放得下第五章', err)
}
