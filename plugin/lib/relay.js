// The relay between a Session's game tab and its Agent. One Game per
// Session, in memory. The tab syncs every ~100 ms (lib/client.js): it
// brings the latest snapshot, what happened, and the results of orders;
// it takes away the Agent's new orders and lines to say. The Agent's
// tools (lib/index.js) wait on the results here.
import { HEROES, LIQUID_ZH, level, name, standing } from './engine.js'

const OPEN_MS = 4000 // a tab that has not synced for this long is gone
const ACTIVE_MS = 25000 // after a tool call, the Agent counts as in the game
const ORDER_MS = 60000
const INBOX = 60
const SETTLE_MS = 400 // a partner standing still this long after moving wakes a waiting Agent

export function createRelay () {
  const games = new Map()
  return {
    get: (sid) => games.get(sid),
    sync (sid, body) {
      let g = games.get(sid)
      if (!g) { g = new Game(sid); games.set(sid, g) }
      return g.sync(body)
    }
  }
}

class Game {
  constructor (sid) {
    this.sid = sid
    this.lastSync = 0
    this.snap = null
    this.run = null
    this.agent = null
    this.reachList = null
    this.next = 0
    this.commands = []
    this.pending = new Map()
    this.said = []
    this.inbox = []
    this.waiters = new Set()
    this.activeUntil = 0
    // Misses: the Agent's failed moves and its hero's deaths on this
    // level. Past TIP_AFTER and HINT_AFTER (lib/index.js) the tools add
    // the level's tip, then the solver's next moves.
    this.misses = 0
    this.hintCache = null
    // The partner's last resting place and who holds which button, so a
    // waiting Agent hears when the user has done their part.
    this.mate = null
    this.held = {}
    this.lastTool = 0
  }

  miss () { this.misses++ }

  open () { return !!this.snap && Date.now() - this.lastSync < OPEN_MS }
  agentHero () { return this.agent === 'ember' || this.agent === 'rime' ? this.agent : null }
  touch () { this.activeUntil = Date.now() + ACTIVE_MS }
  // used marks an Agent tool call; the tab uses the gap since to tell
  // whether the Agent is still in its turn.
  used () {
    this.lastTool = Date.now()
    this.touch()
  }
  reach () { return this.reachList }

  say (text) {
    const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 60)
    if (t) this.said.push({ id: ++this.next, text: t })
  }

  // order queues a command for the tab and waits for its result.
  order (cmd, signal) {
    const id = ++this.next
    this.commands.push({ id, ...cmd })
    this.touch()
    return new Promise((resolve) => {
      const started = Date.now()
      const done = (r) => {
        clearInterval(timer)
        signal?.removeEventListener?.('abort', abort)
        this.pending.delete(id)
        this.touch()
        resolve(r)
      }
      const abort = () => {
        this.commands.push({ id: ++this.next, action: 'stop' })
        done({ ok: false, aborted: true, text: '这一轮被取消了，停下了' })
      }
      const timer = setInterval(() => {
        if (!this.open()) done({ ok: false, aborted: true, text: '游戏页面关掉了' })
        else if (Date.now() - started > ORDER_MS) done({ ok: false, text: '一分钟还没做完，先停在这里' })
        else this.touch()
      }, 500)
      this.pending.set(id, done)
      if (signal?.aborted) abort()
      else signal?.addEventListener?.('abort', abort, { once: true })
    })
  }

  // wait resolves true when something worth reacting to arrives, false
  // after ms.
  wait (ms, signal) {
    if (this.inbox.some((e) => e.notable)) return Promise.resolve(true)
    this.touch()
    return new Promise((resolve) => {
      const w = (v) => {
        clearTimeout(timer)
        clearInterval(keep)
        this.waiters.delete(w)
        signal?.removeEventListener?.('abort', abort)
        this.touch()
        resolve(v)
      }
      const abort = () => w(false)
      const timer = setTimeout(() => w(false), ms)
      const keep = setInterval(() => { if (!this.open()) w(false); else this.touch() }, 500)
      this.waiters.add(w)
      if (signal?.aborted) abort()
      else signal?.addEventListener?.('abort', abort, { once: true })
    })
  }

  drain () {
    const out = this.inbox.map((e) => e.line)
    this.inbox = []
    return out
  }

  push (line, notable) {
    this.inbox.push({ line, notable })
    if (this.inbox.length > INBOX) this.inbox.splice(0, this.inbox.length - INBOX)
    if (notable) for (const w of [...this.waiters]) w(true)
  }

  describe (ev) {
    const me = this.agentHero()
    const who = (k) => (k === me ? '你' : k ? `同伴（${HEROES[k]?.zh ?? k}）` : '有人')
    const L = level(this.snap?.level)
    const nm = (id) => (L ? name(L, id) : id)
    switch (ev.type) {
      case 'lever': return [`${who(ev.by)}把${nm(ev.id)} ${ev.on ? '拉开' : '拉回'}了`, ev.by !== me]
      case 'button': {
        if (ev.on) {
          this.held[ev.id] = ev.by
          return [`${who(ev.by)}踩下了${nm(ev.id)}`, ev.by !== me]
        }
        const by = this.held[ev.id]
        delete this.held[ev.id]
        return by && by !== me ? [`${who(by)}松开了${nm(ev.id)}`, true] : [`${nm(ev.id)} 弹起了`, false]
      }
      case 'gate': return [`${nm(ev.id)} ${ev.open ? '开了' : '关了'}`, false]
      case 'lift': return [`${nm(ev.id)} ${ev.up ? '升到顶' : '降到底'}了`, false]
      case 'gem': return [`${who(ev.by)}拿到宝石 ${ev.id}`, false]
      case 'exit': return ev.at ? [`${who(ev.who)}站到出口了`, ev.who !== me] : null
      case 'died':
        if (ev.who === me) this.miss()
        return [`${who(ev.who)}${ev.liquid ? `碰到${LIQUID_ZH[ev.liquid]}` : '掉下去'}倒下了，关卡重开`, true]
      case 'complete': return [`过关！用时 ${ev.seconds}s，宝石 ${ev.gems}/${ev.of}`, true]
      case 'level': {
        if (!ev.restart) { this.misses = 0; this.hintCache = null }
        this.mate = null
        this.held = {}
        const NL = level(ev.id)
        return [`${ev.restart ? '重新开始' : '开始'}第 ${ev.id} 关「${NL?.name ?? ''}」，你是${HEROES[me]?.zh ?? '?'}`, true]
      }
      case 'ping': return [`同伴在 (${ev.x},${ev.y})${ev.label ? `（${ev.label}）` : ''}打了个标记，想让你看这里`, true]
      case 'chat': return [`同伴说：「${String(ev.text ?? '').slice(0, 200)}」`, true]
      default: return null
    }
  }

  // watchMate tells a waiting Agent when its partner, having moved a
  // tile or more, has stood still on the ground for SETTLE_MS: they have
  // likely done their part (stood on a lift, reached a spot) without
  // saying so.
  watchMate (now) {
    const me = this.agentHero()
    const s = this.snap
    const h = me && s.status === 'playing' ? s.heroes?.[me === 'ember' ? 'rime' : 'ember'] : null
    if (!h?.alive) { this.mate = null; return }
    const x = +h.x
    const y = +h.y
    const m = this.mate
    if (!m) { this.mate = { x, y, ax: x, ay: y, still: now }; return }
    if (Math.abs(x - m.x) > 0.02 || Math.abs(y - m.y) > 0.02 || !h.ground) {
      m.x = x
      m.y = y
      m.still = now
      return
    }
    if (now - m.still < SETTLE_MS || Math.hypot(x - m.ax, y - m.ay) < 1) return
    m.ax = x
    m.ay = y
    const L = level(s.level)
    if (!L) return
    const st = standing(L, s, me === 'ember' ? 'rime' : 'ember')
    this.push(`同伴停在${st.where} (${st.x},${st.y})${st.on ? '，' + st.on : ''}`, true)
  }

  sync (body) {
    const now = Date.now()
    if (body.run && body.run !== this.run) {
      // A new tab (or a reload): orders the old one had are lost.
      if (this.run) for (const done of [...this.pending.values()]) done({ ok: false, aborted: true, text: '游戏页面重新加载了' })
      this.run = body.run
      this.commands = []
    }
    this.lastSync = now
    if (body.snapshot && typeof body.snapshot === 'object') this.snap = body.snapshot
    this.agent = body.agent ?? null
    if (Array.isArray(body.reach) || body.reach === null) this.reachList = body.reach
    for (const ev of Array.isArray(body.events) ? body.events.slice(0, 200) : []) {
      const d = ev && typeof ev === 'object' ? this.describe(ev) : null
      if (d) this.push(d[0], d[1])
    }
    if (body.snapshot && typeof body.snapshot === 'object') this.watchMate(now)
    for (const r of Array.isArray(body.results) ? body.results : []) {
      this.pending.get(r?.id)?.({ ok: !!r.ok, text: String(r.text ?? '') })
    }
    const out = {
      commands: this.commands.splice(0),
      said: this.said.splice(0),
      agent: { active: now < this.activeUntil || this.pending.size > 0 || this.waiters.size > 0, busy: this.pending.size > 0, waiting: this.waiters.size > 0, idle: this.lastTool ? now - this.lastTool : null }
    }
    return out
  }
}
