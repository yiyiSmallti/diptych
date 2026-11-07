// Diptych in dsh web: a tab type for the right Sidebar. The person plays
// one hero with the keyboard; the Session's Agent plays the other through
// its tools (lib/index.js), which reach this tab through the host's relay
// (POST api/diptych/sync, every ~100 ms) and are carried out here by the
// engine's autopilot. The engine (lib/engine.js) is imported from the host
// so the browser, the host and the tests share one copy of the physics.
//
// Loaded by dsh's client module system (window.__ModuleLoader__); React
// comes from the platform module table, the game itself is a canvas.
window.__ModuleLoader__.load({
  id: '@precinct/diptych',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useEffect, useRef } = React
    const ID = '@precinct/diptych'
    const KIND = 'diptych'
    const STORE = 'diptych:v1'

    let enginePromise = null
    const loadEngine = () => (enginePromise ??= import(new URL('api/diptych/engine.js', document.baseURI).href).catch((err) => { enginePromise = null; throw err }))

    // The painted art (plugin/art, served by lib/index.js): heroes, gems,
    // doors, machine parts, wall textures and one backdrop per chapter.
    const ART = ['ember', 'rime', 'gem-ember', 'gem-rime', 'exit-ember', 'exit-rime', 'lever-base', 'lever-handle', 'plate', 'portcullis', 'lift', 'plank', 'slab', 'wall1', 'wall2', 'wall3', 'bg1', 'bg2', 'bg3', 'bg4', 'bg5']
    // Per chapter: its backdrop and the stone its walls are built from.
    const THEMES = [{ bg: 'bg1', wall: 'wall1' }, { bg: 'bg2', wall: 'wall2' }, { bg: 'bg3', wall: 'wall2' }, { bg: 'bg4', wall: 'wall3' }, { bg: 'bg5', wall: 'wall2' }]
    const art = {}
    let artPromise = null
    const loadArt = () => (artPromise ??= Promise.all(ART.map((name) => new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => { art[name] = img; resolve() }
      img.onerror = () => reject(new Error(`图片 ${name} 没能加载`))
      img.src = new URL(`api/diptych/art/${name}.webp`, document.baseURI).href
    }))).catch((err) => { artPromise = null; throw err }))

    let hostCtx = null
    const games = new Map()
    // For the end-to-end tests and the curious: the open games by Session.
    window.__diptych = { games }

    // ------------------------------------------------------------ helpers

    function el (tag, attrs, ...kids) {
      const n = document.createElement(tag)
      for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v === undefined || v === null || v === false) continue
        if (k === 'class') n.className = v
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v)
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v)
        else if (k === 'html') n.innerHTML = v
        else n.setAttribute(k, v === true ? '' : v)
      }
      for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) n.append(kid instanceof Node ? kid : String(kid))
      return n
    }
    const load = () => { try { return JSON.parse(localStorage.getItem(STORE) ?? '{}') ?? {} } catch { return {} } }
    const save = (patch) => { try { localStorage.setItem(STORE, JSON.stringify({ ...load(), ...patch })) } catch {} }
    const rand = () => Math.random().toString(36).slice(2, 10)

    async function sync (body) {
      const res = await fetch('api/diptych/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
      return data
    }

    // send puts a message from the person into the Session, which starts
    // (or queues) an Agent turn.
    async function sendToSession (sessionId, text) {
      const conv = hostCtx?.get?.('sessions')?.scope?.(sessionId)?.get?.('conversation')
      if (!conv) throw new Error('这个会话现在不能发消息')
      await conv.send(text)
    }

    // ------------------------------------------------------------ drawing
    //
    // The look: painted sprites and a backdrop per chapter, lit warm from
    // the left and cool from the right (the two panels of the diptych).
    // Walls, ledges and the backdrop are painted once per level and size;
    // liquids, machinery, heroes and particles every frame.

    const PAL = {
      bg1: '#0b0a17', mortar: '#29243f', ironLo: '#2a2f45', brass: '#e0b25a',
      ember: '#ff7a3d', emberHi: '#ffd166', rime: '#5cc8ff', rimeHi: '#eafaff'
    }
    const LIQ = {
      lava: { deep: '#a51d0c', mid: '#ff5a1f', top: '#ffb347', glow: '#ff6a2a', fleck: '#fff0b0' },
      frost: { deep: '#123f8f', mid: '#2f8fe8', top: '#a6e6ff', glow: '#4cb8ff', fleck: '#ffffff' },
      ooze: { deep: '#341270', mid: '#7a3fe0', top: '#cfa3ff', glow: '#9b5cff', fleck: '#f1e2ff' }
    }

    const hash = (x, y, k = 0) => {
      let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(k | 0, 1442695041)
      h = Math.imul(h ^ (h >>> 13), 1274126177)
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296
    }
    const rgba = (hex, a) => {
      const n = parseInt(hex.slice(1), 16)
      return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`
    }
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
    const CHAT_MIN = 88 // px of chat log kept visible below the level
    const KEEP_MS = 8000 // how long a new level waits for the Agent before calling it back

    const glowCache = new Map()
    function glowSprite (color) {
      let c = glowCache.get(color)
      if (!c) {
        c = document.createElement('canvas')
        c.width = c.height = 64
        const g = c.getContext('2d')
        const r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
        r.addColorStop(0, rgba(color, 0.9))
        r.addColorStop(0.35, rgba(color, 0.35))
        r.addColorStop(1, rgba(color, 0))
        g.fillStyle = r
        g.fillRect(0, 0, 64, 64)
        glowCache.set(color, c)
      }
      return c
    }
    function drawGlow (g, color, cx, cy, r, alpha = 1) {
      if (alpha <= 0) return
      g.save()
      g.globalCompositeOperation = 'lighter'
      g.globalAlpha = alpha
      g.drawImage(glowSprite(color), cx - r, cy - r, r * 2, r * 2)
      g.restore()
    }

    function roundRect (g, x, y, w, h, r) {
      r = Math.max(0, Math.min(r, w / 2, h / 2))
      g.beginPath()
      g.moveTo(x + r, y)
      g.arcTo(x + w, y, x + w, y + h, r)
      g.arcTo(x + w, y + h, x, y + h, r)
      g.arcTo(x, y + h, x, y, r)
      g.arcTo(x, y, x + w, y, r)
      g.closePath()
    }

    function star (g, cx, cy, r, color, alpha = 1) {
      g.save()
      g.globalAlpha = alpha
      g.fillStyle = color
      g.beginPath()
      g.moveTo(cx, cy - r)
      g.quadraticCurveTo(cx, cy, cx + r, cy)
      g.quadraticCurveTo(cx, cy, cx, cy + r)
      g.quadraticCurveTo(cx, cy, cx - r, cy)
      g.quadraticCurveTo(cx, cy, cx, cy - r)
      g.fill()
      g.restore()
    }

    // drawHero: x, y are the top-left of the 0.7 x 0.9 box in pixels. The
    // painted sprite faces right; it breathes on the ground, stretches in
    // the air and leans into a run.
    function drawHero (g, kind, x, y, T, t, opts = {}) {
      const w = 0.7 * T
      const h = 0.9 * T
      const cx = x + w / 2
      const by = y + h
      const vy = opts.vy ?? 0
      const sy = opts.ground === false ? clamp(1 - vy * 0.012, 0.86, 1.16) : 1 + Math.sin(t * 3 + (kind === 'ember' ? 0 : 1.7)) * 0.025
      const sx = 1 / Math.sqrt(sy)
      const f = (opts.facing ?? 1) < 0 ? -1 : 1
      g.save()
      if (opts.dead) g.globalAlpha = 0.3
      if (opts.ground !== false && !opts.dead) {
        g.fillStyle = 'rgba(0,0,0,.35)'
        g.beginPath()
        g.ellipse(cx, by - 0.02 * T, w * 0.6, T * 0.08, 0, 0, Math.PI * 2)
        g.fill()
      }
      if (!opts.dead && opts.glow !== false) drawGlow(g, kind === 'ember' ? PAL.ember : PAL.rime, cx, by - h * 0.5, T * 1.25, 0.55)
      const img = art[kind]
      const dh = 1.2 * T
      const dw = dh * img.width / img.height
      g.translate(cx, by + 0.02 * T)
      g.rotate(clamp((opts.vx ?? 0) * 0.014, -0.1, 0.1))
      g.scale(sx * f, sy)
      g.drawImage(img, -dw / 2, -dh, dw, dh)
      g.restore()
    }

    function drawGem (g, kind, x, y, T, t) {
      const bob = Math.sin(t * 2.6 + x * 0.07) * 0.07 * T
      const cx = x + T / 2
      const cy = y + T / 2 + bob
      drawGlow(g, kind === 'ember' ? PAL.ember : PAL.rime, cx, cy, T * 0.8, 0.6 + Math.sin(t * 4 + x) * 0.15)
      const img = art['gem-' + kind]
      const dh = 0.62 * T
      const dw = dh * img.width / img.height
      g.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh)
      const tw = (t * 0.9 + hash(x, y)) % 1
      if (tw < 0.18) star(g, cx - dw * 0.22, cy - dh * 0.28, T * 0.16 * Math.sin(tw / 0.18 * Math.PI), '#ffffff', 0.95)
    }

    // drawExit: the arch stands on the exit cell; it lights up while its
    // hero stands in it.
    function drawExit (g, kind, x, y, T, lit, t) {
      const c = kind === 'ember' ? PAL.ember : PAL.rime
      const img = art['exit-' + kind]
      const h = 1.75 * T
      const w = h * img.width / img.height
      const dx = x + (T - w) / 2
      const dy = y + T - h
      const cx = dx + w / 2
      drawGlow(g, c, cx, dy + h * 0.6, T * (lit ? 1.7 : 1.1), lit ? 0.8 : 0.35)
      g.drawImage(img, dx, dy, w, h)
      if (lit) {
        g.save()
        g.globalCompositeOperation = 'lighter'
        g.globalAlpha = 0.3 + Math.sin(t * 5) * 0.08
        g.drawImage(img, dx, dy, w, h)
        g.restore()
      }
      // Light motes rising inside the door.
      for (let i = 0; i < 3; i++) {
        const p = (t * (lit ? 0.9 : 0.4) + i / 3) % 1
        g.fillStyle = rgba(lit ? '#ffffff' : c, (1 - p) * (lit ? 0.9 : 0.5))
        g.beginPath()
        g.arc(cx + Math.sin(p * 6 + i * 2) * w * 0.16, dy + h - p * h * 0.6, T * 0.035, 0, Math.PI * 2)
        g.fill()
      }
    }

    // tileFill covers a rectangle with rows of a sprite, each cell wide,
    // clipped to the rectangle (planks, trapdoor slabs).
    function tileFill (g, img, x, y, w, h, cell) {
      if (h <= 0.5) return
      const rh = cell * img.height / img.width
      g.save()
      g.beginPath()
      g.rect(x, y, w, h)
      g.clip()
      for (let yy = y; yy < y + h; yy += rh * 0.92) {
        for (let xx = x; xx < x + w - 0.5; xx += cell) g.drawImage(img, xx, yy, cell, rh)
      }
      g.restore()
    }

    function lamp (g, color, cx, cy, r, on) {
      g.fillStyle = PAL.ironLo
      g.beginPath()
      g.arc(cx, cy, r * 1.35, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = on ? color : rgba(color, 0.35)
      g.beginPath()
      g.arc(cx, cy, r, 0, Math.PI * 2)
      g.fill()
      if (on) drawGlow(g, color, cx, cy, r * 4, 0.6)
    }

    // ------------------------------------------------------------ the game

    const QUICK = ['等我一下', '好了，走吧', '按住别动', '来这边', '你先走']
    // Seconds from a win to the next level starting by itself.
    const NEXT_SECONDS = 4

    class Game {
      constructor (host, sessionId) {
        this.host = host
        this.sessionId = sessionId
        this.run = rand()
        // When the user last touched this page; with two pages open the
        // Session follows the one touched last (see relay.js).
        this.claim = Date.now()
        this.standby = false
        this.E = null
        this.W = null
        this.L = null
        this.mode = 'loading'
        const st = load()
        this.human = st.hero === 'rime' ? 'rime' : 'ember'
        this.duo = st.duo !== false
        this.unlocked = Math.max(1, st.unlocked ?? 1)
        this.levelId = st.level ?? '1'
        this.best = st.best ?? {}
        this.keys = new Set()
        this.prevJump = { ember: false, rime: false }
        this.useEdge = { ember: false, rime: false }
        this.outEvents = []
        this.results = []
        this.chat = []
        this.bubbles = {}
        this.pings = []
        this.agent = { active: false, busy: false, waiting: false }
        this.agentDoing = ''
        this.assistPilot = null
        this.reach = null
        this.reachKey = ''
        this.reachAt = 0
        this.lastSync = 0
        this.syncing = false
        this.syncErr = ''
        this.alive = true
        this.build()
        games.set(sessionId, this)
        Promise.all([loadEngine(), loadArt()]).then(([E]) => {
          if (!this.alive) return
          this.E = E
          this.mode = 'menu'
          // A level left half way is picked up where it was.
          if (!this.resume(load().run)) this.renderMenu()
          this.loop()
        }, (err) => {
          this.overlay(el('div', { class: 'dp-card' }, el('h3', {}, '游戏没能加载'), el('p', {}, String(err?.message ?? err))))
        })
        this.timer = setInterval(() => this.syncNow(), 100)
        this.onHide = () => this.saveRun()
        window.addEventListener('pagehide', this.onHide)
        document.addEventListener('visibilitychange', this.onHide)
      }

      dispose () {
        this.saveRun()
        clearTimeout(this.nextTimer)
        window.removeEventListener('pagehide', this.onHide)
        document.removeEventListener('visibilitychange', this.onHide)
        this.alive = false
        clearInterval(this.timer)
        cancelAnimationFrame(this.raf)
        this.ro?.disconnect()
        if (games.get(this.sessionId) === this) games.delete(this.sessionId)
        this.root.remove()
      }

      // ---------------------------------------------------- DOM

      build () {
        this.canvas = el('canvas', { class: 'dp-canvas', 'aria-label': '游戏画面' })
        this.ov = el('div', { class: 'dp-ov' })
        this.focusHint = el('div', { class: 'dp-hint', hidden: true }, '点一下画面开始操作')
        this.stage = el('div', { class: 'dp-stage' }, this.canvas, this.focusHint, this.ov)
        this.titleEl = el('span', { class: 'dp-title' }, '双联画')
        this.clockEl = el('span', { class: 'dp-clock' })
        this.gemsEl = el('span', { class: 'dp-gems' })
        const btn = (label, title, fn) => el('button', { type: 'button', class: 'dp-btn', title, onclick: fn }, label)
        this.restartBtn = btn('重开', '重新开始这一关 (R)', () => this.restart(true))
        this.menuBtn = btn('选关', '回到选关', () => this.toMenu())
        const top = this.top = el('div', { class: 'dp-top' }, this.titleEl, this.clockEl, this.gemsEl, el('span', { class: 'dp-sp' }), this.restartBtn, this.menuBtn)
        this.agentChip = el('div', { class: 'dp-agent' })
        this.log = el('div', { class: 'dp-log', role: 'log', 'aria-live': 'polite' })
        this.input = el('input', { class: 'dp-in', placeholder: '跟同伴说点什么，回车发送', maxlength: '200' })
        this.input.addEventListener('keydown', (e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.say(this.input.value); this.input.value = '' }
          if (e.key === 'Escape') this.root.focus()
        })
        this.quick = el('div', { class: 'dp-quick' }, QUICK.map((q) => el('button', { type: 'button', class: 'dp-q', onclick: () => this.say(q) }, q)))
        this.help = el('div', { class: 'dp-help' })
        this.root = el('div', { class: 'dp', tabindex: '0' }, top, this.stage, this.agentChip, el('div', { class: 'dp-chat' }, this.log, this.quick, this.input), this.help)
        this.host.append(this.root)
        const touch = () => { this.claim = Date.now() }
        this.root.addEventListener('pointerdown', touch, true)
        this.root.addEventListener('keydown', touch, true)
        this.root.addEventListener('keydown', (e) => this.key(e, true))
        this.root.addEventListener('keyup', (e) => this.key(e, false))
        this.root.addEventListener('focusin', () => this.updateHint())
        this.root.addEventListener('focusout', () => { this.keys.clear(); setTimeout(() => this.updateHint(), 0) })
        this.canvas.addEventListener('mousedown', () => this.root.focus())
        this.focusHint.addEventListener('mousedown', (e) => { e.preventDefault(); this.root.focus() })
        this.canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.ping(e) })
        this.ro = new ResizeObserver(() => this.resize())
        this.ro.observe(this.stage)
        this.ro.observe(this.root)
        this.updateChrome()
      }

      overlay (node) {
        this.ov.replaceChildren(...(node ? [node] : []))
        this.ov.hidden = !node
        this.stage.classList.toggle('tall', !!node && node.classList?.contains('dp-menu'))
        this.updateHint()
      }

      updateHint () {
        this.focusHint.hidden = !(this.mode === 'play' && this.ov.hidden && !this.root.contains(document.activeElement))
      }

      resize () {
        const L = this.L ?? { w: 28, h: 12 }
        const box = this.stage.getBoundingClientRect()
        const avail = Math.max(200, box.width - 2)
        // The level fills the Sidebar as far as its width and height allow,
        // keeping room below for the status, a few lines of chat and the
        // input; it grows when the Sidebar is dragged wider or fullscreen.
        const below = [this.top, this.agentChip, this.quick, this.input, this.help].reduce((n, e) => n + (e?.offsetHeight ?? 0), 0)
        const tall = this.root.clientHeight - below - CHAT_MIN - 60
        const T = Math.max(10, Math.min(56, Math.floor(avail / L.w), tall > 0 ? Math.floor(tall / L.h) : 56))
        this.T = T
        const dpr = window.devicePixelRatio || 1
        this.canvas.width = Math.round(L.w * T * dpr)
        this.canvas.height = Math.round(L.h * T * dpr)
        this.canvas.style.width = L.w * T + 'px'
        this.canvas.style.height = L.h * T + 'px'
        this.dpr = dpr
        this.staticLayer = null
      }

      updateChrome () {
        const L = this.L
        this.titleEl.textContent = L && this.mode !== 'menu' ? `第 ${L.id} 关 · ${L.name}` : '双联画'
        const playing = this.mode === 'play' && this.W
        this.restartBtn.hidden = !playing
        this.menuBtn.hidden = this.mode === 'menu' || this.mode === 'loading'
        this.clockEl.hidden = this.gemsEl.hidden = !playing
        const ak = this.agentKind
        if (this.standby && this.duo) {
          this.agentChip.className = 'dp-agent'
          const here = el('button', { type: 'button', class: 'dp-invite', onclick: () => { this.claim = Date.now(); this.syncNow() } }, '在这里玩')
          this.agentChip.replaceChildren(el('span', {}, '这局在另一个页面里和 Agent 玩着'), here)
        } else if (!this.duo) {
          this.agentChip.className = 'dp-agent off'
          this.agentChip.replaceChildren(el('span', {}, '单人练习：WASD 控制烬，方向键控制凇'))
        } else if (this.agent.active) {
          this.agentChip.className = 'dp-agent on'
          this.agentChip.replaceChildren(el('span', { class: 'dp-dot' }), el('span', {}, `Agent 在玩${this.E ? this.E.HEROES[ak].zh : ''}${this.agentDoing ? '：' + this.agentDoing : this.agent.waiting ? '：在等你' : this.agent.busy ? '' : '：在想'}`))
        } else {
          this.agentChip.className = 'dp-agent'
          const invite = el('button', { type: 'button', class: 'dp-invite', onclick: () => this.invite() }, '叫 Agent 来玩')
          this.agentChip.replaceChildren(el('span', {}, this.mode === 'play' ? 'Agent 还没进游戏' : '选好关卡和角色，再叫 Agent'), this.mode === 'play' ? invite : '')
        }
        this.input.disabled = !this.duo
        this.quick.hidden = !this.duo
        const keys = this.duo ? '方向键或 WASD 移动，↑/W/空格 跳，↓/S 拉拉杆；右键地图打标记给 Agent 看' : 'WASD：烬（W 跳，S 拉杆）；方向键：凇（↑ 跳，↓ 拉杆）'
        this.help.textContent = keys
      }

      get agentKind () { return this.duo ? (this.human === 'ember' ? 'rime' : 'ember') : null }

      addLog (who, text) {
        this.chat.push({ who, text })
        if (this.chat.length > 80) this.chat.shift()
        const cls = who === 'agent' ? 'a' : who === 'me' ? 'm' : 's'
        const name = who === 'agent' ? `${this.E?.HEROES[this.agentKind]?.zh ?? ''}（Agent）` : who === 'me' ? '我' : ''
        this.log.append(el('div', { class: 'dp-l ' + cls }, name ? el('b', {}, name + '：') : '', text))
        while (this.log.childNodes.length > 60) this.log.firstChild.remove()
        this.log.scrollTop = this.log.scrollHeight
      }

      // ---------------------------------------------------- menu

      renderMenu () {
        this.mode = 'menu'
        this.W = null
        const E = this.E
        if (Number(this.levelId) > this.unlocked || !E.level(this.levelId)) this.levelId = String(Math.min(this.unlocked, E.LEVELS.length))
        this.L = E.level(this.levelId)
        this.updateChrome()
        const n = Number(this.levelId)
        const chapters = E.CHAPTERS.map((c, i) => ({ ...c, to: (E.CHAPTERS[i + 1]?.from ?? E.LEVELS.length + 1) - 1 }))
        if (this.chapter == null || !chapters[this.chapter]) this.chapter = Math.max(0, chapters.findIndex((c) => n >= c.from && n <= c.to))
        const ch = chapters[this.chapter]
        const heroCard = (k) => {
          const c = el('canvas', { width: 120, height: 120, class: 'dp-hc' })
          const g = c.getContext('2d')
          drawGlow(g, k === 'ember' ? PAL.ember : PAL.rime, 60, 64, 56, 0.5)
          drawHero(g, k, 30.6, 32, 84, 0.4, { facing: 1, glow: false })
          return el('button', { type: 'button', class: 'dp-hero ' + k + (this.human === k ? ' on' : ''), onclick: () => { this.human = k; save({ hero: k }); this.renderMenu() } },
            c, el('b', {}, `${E.HEROES[k].zh} ${E.HEROES[k].en}`), el('small', {}, k === 'ember' ? '火 · 走得过熔岩' : '冰 · 走得过寒潭'))
        }
        const tabs = el('div', { class: 'dp-tabs' }, chapters.map((c, i) => {
          const done = E.LEVELS.slice(c.from - 1, c.to).filter((d) => this.best[d.id]).length
          const locked = c.from > this.unlocked
          return el('button', { type: 'button', class: 'dp-tab' + (i === this.chapter ? ' on' : ''), disabled: locked, title: `${c.name} · ${c.en}`, onclick: () => { this.chapter = i; this.renderMenu() } },
            el('b', {}, c.name), el('small', {}, locked ? '未解锁' : `${done}/${c.to - c.from + 1}`))
        }))
        const grid = el('div', { class: 'dp-levels' }, E.LEVELS.slice(ch.from - 1, ch.to).map((d) => {
          const locked = Number(d.id) > this.unlocked
          const best = this.best[d.id]
          const all = best && best.of > 0 && best.gems === best.of
          return el('button', {
            type: 'button', class: 'dp-lv' + (d.id === this.levelId ? ' on' : '') + (best ? ' done' : '') + (all ? ' all' : ''), disabled: locked,
            title: locked ? '先过前一关' : `${d.name} · ${d.en}`, 'aria-label': `第 ${d.id} 关 ${d.name}`,
            onclick: () => { this.levelId = d.id; save({ level: d.id }); this.renderMenu() }
          }, el('b', {}, d.id), el('span', {}, locked ? '·' : d.name), el('i', {}, best ? (all ? '◆' : '✓') : ''))
        }))
        const d = E.LEVELS.find((x) => x.id === this.levelId)
        const best = this.best[this.levelId]
        const info = el('div', { class: 'dp-info' },
          el('div', { class: 'dp-info-h' }, el('b', {}, `第 ${d.id} 关 · ${d.name}`), el('span', {}, d.en), best ? el('small', {}, `最好 ${best.seconds} 秒 · 宝石 ${best.gems}/${best.of}`) : ''),
          el('details', {}, el('summary', {}, '看提示'), el('p', {}, d.tip)))
        const seg = el('div', { class: 'dp-seg' },
          el('button', { type: 'button', class: this.duo ? 'on' : '', onclick: () => { this.duo = true; save({ duo: true }); this.renderMenu() } }, '和 Agent 一起'),
          el('button', { type: 'button', class: this.duo ? '' : 'on', onclick: () => { this.duo = false; save({ duo: false }); this.renderMenu() } }, '一个人练习'))
        const run = load().run
        const runL = run && Number(run.level) <= this.unlocked ? E.level(run.level) : null
        const start = el('div', { class: 'dp-row' },
          runL ? el('button', { type: 'button', class: 'dp-go', onclick: () => this.resume(run) }, `继续第 ${runL.id} 关 · ${Math.floor((run.world?.tick ?? 0) * E.TICK)} 秒`) : '',
          el('button', { type: 'button', class: runL ? 'dp-btn' : 'dp-go', onclick: () => this.start(this.levelId) }, `${runL && runL.id === d.id ? '重新开始' : '开始'}第 ${d.id} 关`))
        const total = E.LEVELS.filter((x) => this.best[x.id]).length
        this.overlay(el('div', { class: 'dp-card dp-menu' },
          el('div', { class: 'dp-brand' }, el('i', { class: 'e' }), el('h2', {}, '双联画'), el('i', { class: 'r' })),
          el('p', { class: 'dp-sub' }, `一个是火，一个是冰。${E.LEVELS.length} 关，每一关都得两个人一起过。${total ? `已过 ${total} 关。` : ''}`),
          this.duo ? el('div', { class: 'dp-pick' }, heroCard('ember'), heroCard('rime')) : '',
          seg, tabs, grid, info, start,
          this.duo ? el('p', { class: 'dp-note' }, `开始后点「叫 Agent 来玩」，它会控制${E.HEROES[this.agentKind].zh}。`) : el('p', { class: 'dp-note' }, 'WASD 控制烬，方向键控制凇。')))
        this.resize()
        this.draw(0)
      }

      toMenu () {
        this.saveRun()
        this.cancelNext()
        this.assistPilot = null
        this.pilot?.cancel('回到选关了')
        this.outEvents.push({ type: 'chat', text: '（我回到了选关界面）' })
        this.renderMenu()
      }

      start (id, restart = false, quiet = false) {
        const E = this.E
        this.cancelNext()
        this.levelId = id
        this.chapter = null
        save({ level: id })
        this.L = E.level(id)
        this.W = E.createWorld(this.L)
        this.pilot?.cancel(restart ? '关卡重开了' : '换关了')
        this.pilot = this.duo ? new E.Pilot(this.agentKind) : null
        this.assistPilot = null
        this.agentDoing = ''
        this.reach = null
        this.reachKey = ''
        this.bubbles = {}
        this.mode = 'play'
        this.overlay(null)
        this.resize()
        this.updateChrome()
        this.outEvents.push({ type: 'level', id, restart })
        if (!restart) {
          this.levelAt = performance.now()
          this.nudge = !!this.carry && this.duo
          this.carry = false
        }
        if (!restart && !quiet) this.addLog('s', `第 ${id} 关「${this.L.name}」开始`)
        this.root.focus()
        this.saveRun()
      }

      // ---------------------------------------------------- saving
      //
      // Besides the unlocked levels and best results, the browser keeps the
      // level being played (where the heroes stand, levers, gates, lifts,
      // gems taken), saved every second and when the page is hidden, so a
      // refresh or a closed tab carries on where it was.

      saveRun () {
        const W = this.W
        if (!W || this.mode !== 'play' || W.status !== 'playing') return
        save({
          run: {
            level: this.levelId, human: this.human, duo: this.duo, at: Date.now(),
            world: { tick: W.tick, heroes: { ember: { ...W.heroes.ember }, rime: { ...W.heroes.rime } }, taken: [...W.taken], levers: { ...W.levers }, gates: { ...W.gates }, lifts: { ...W.lifts } }
          }
        })
      }

      // resume starts the saved level and puts everything back where it
      // was; false when there is nothing (usable) to resume.
      resume (run) {
        const E = this.E
        const L = run && E.level(run.level)
        if (!L || Number(run.level) > this.unlocked || typeof run.world !== 'object') return false
        // Only values of the shape the fresh world has are taken over.
        const pick = (dst, src) => {
          for (const k of Object.keys(dst)) if (src && typeof src[k] === typeof dst[k] && k !== 'kind') dst[k] = src[k]
        }
        this.human = run.human === 'rime' ? 'rime' : 'ember'
        this.duo = run.duo !== false
        save({ hero: this.human, duo: this.duo })
        this.start(L.id, false, true)
        const W = this.W
        const w = run.world
        if (Number.isInteger(w.tick) && w.tick > 0) W.tick = w.tick
        for (const k of ['ember', 'rime']) {
          const h = W.heroes[k]
          pick(h, w.heroes?.[k])
          h.ground = typeof w.heroes?.[k]?.ground === 'string' ? w.heroes[k].ground : null
        }
        if (Array.isArray(w.taken)) W.taken = new Set(w.taken.filter((id) => L.gems.some((g) => g.id === id)))
        pick(W.levers, w.levers)
        pick(W.gates, w.gates)
        pick(W.lifts, w.lifts)
        this.updateGems()
        this.clockEl.textContent = `${Math.floor(W.tick * E.TICK)}s`
        this.addLog('s', `继续第 ${L.id} 关「${L.name}」（上次玩到 ${Math.floor(W.tick * E.TICK)} 秒）`)
        this.updateChrome()
        this.saveRun()
        return true
      }

      // ---------------------------------------------------- next level
      //
      // After a win the next level starts by itself after a short
      // countdown, unless the person stays.

      scheduleNext (next) {
        this.cancelNext()
        let left = NEXT_SECONDS
        const tick = () => {
          if (!this.alive) return
          if (left <= 0) { this.start(next.id); return }
          if (this.countEl) this.countEl.textContent = `${left} 秒后自动进入下一关`
          left--
          this.nextTimer = setTimeout(tick, 1000)
        }
        this.pendingNext = next.id
        tick()
      }

      cancelNext () {
        clearTimeout(this.nextTimer)
        this.nextTimer = null
        this.pendingNext = null
        if (this.countEl) this.countEl.textContent = ''
      }

      restart (byHand) {
        if (!this.W) return
        if (byHand) this.addLog('s', '重开这一关')
        this.start(this.levelId, true)
      }

      // ---------------------------------------------------- talk

      say (raw) {
        const text = String(raw ?? '').trim()
        if (!text || !this.duo) return
        this.addLog('me', text)
        this.bubbles[this.human] = { text, until: performance.now() + 4000 }
        if (this.agent.active || this.mode !== 'play') {
          this.outEvents.push({ type: 'chat', text })
          return
        }
        // The Agent is not in the game: the line goes to the Session as a
        // message, which brings it in.
        const E = this.E
        sendToSession(this.sessionId, `（在双联画里对你说）${text}\n——我在玩${E.HEROES[this.human].zh}，你是${E.HEROES[this.agentKind].zh}，第 ${this.levelId} 关。`).catch((err) => this.addLog('s', '没发出去：' + err.message))
      }

      // keepAgent brings the Agent back for a new level when it played the
      // last one but has ended its turn since, so the user does not invite
      // it again every level. A tool call or a wait since the level began
      // means it is still playing.
      keepAgent () {
        if (!this.nudge || this.standby) return
        if (this.mode !== 'play' || !this.duo) { this.nudge = false; return }
        const since = performance.now() - this.levelAt
        const a = this.agent
        if (a.busy || a.waiting || (a.idle != null && a.idle < since)) { this.nudge = false; return }
        if (since < KEEP_MS) return
        this.nudge = false
        const E = this.E
        const text = `第 ${this.L.id} 关「${this.L.name}」开始了，接着一起玩吧！我还是${E.HEROES[this.human].zh}，你是${E.HEROES[this.agentKind].zh}。`
        sendToSession(this.sessionId, text).then(() => this.addLog('s', '已经叫 Agent 回来接着玩'), (err) => this.addLog('s', '没叫回 Agent：' + err.message))
      }

      invite () {
        const E = this.E
        if (!E) return
        const L = this.L ?? E.level(this.levelId)
        const text = `来玩双联画吧！我是${E.HEROES[this.human].zh}，你是${E.HEROES[this.agentKind].zh}。第 ${L.id} 关「${L.name}」已经开好了，先看看地图，跟我说说你的打算。`
        sendToSession(this.sessionId, text).then(() => this.addLog('s', '已经叫 Agent 了，它进来后会在这里说话'), (err) => this.addLog('s', '没叫到 Agent：' + err.message))
      }

      ping (e) {
        if (this.mode !== 'play' || !this.W || !this.T) return
        const r = this.canvas.getBoundingClientRect()
        const x = Math.floor((e.clientX - r.left) / this.T)
        const y = Math.floor((e.clientY - r.top) / this.T)
        if (x < 0 || y < 0 || x >= this.L.w || y >= this.L.h) return
        let label = ''
        let best = 3
        for (const o of [...this.L.buttons, ...this.L.levers, ...this.L.gates, ...this.L.lifts]) {
          const d = Math.abs(o.x - x) + Math.abs(o.y - y)
          if (d < best) { best = d; label = `${{ button: '按钮', lever: '拉杆', gate: '闸门', lift: '升降台' }[o.type]} ${o.id} 旁边` }
        }
        for (const k of ['ember', 'rime']) {
          const ex = this.L.exits[k]
          if (ex.x === x && ex.y === y) label = `${this.E.HEROES[k].zh}的出口`
        }
        this.pings.push({ x, y, at: performance.now() })
        if (this.duo) this.outEvents.push({ type: 'ping', x, y, label })
      }

      // ---------------------------------------------------- input

      key (e, down) {
        if (e.target === this.input) return
        const map = {
          KeyA: ['ember', 'left'], KeyD: ['ember', 'right'], KeyW: ['ember', 'jump'], KeyS: ['ember', 'use'],
          ArrowLeft: ['rime', 'left'], ArrowRight: ['rime', 'right'], ArrowUp: ['rime', 'jump'], ArrowDown: ['rime', 'use'],
          Space: ['any', 'jump'], KeyE: ['any', 'use']
        }
        const m = map[e.code]
        if (!m) {
          if (down && e.code === 'KeyR' && this.mode === 'play' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); this.restart(true) }
          if (down && e.code === 'Enter' && this.duo) { e.preventDefault(); this.input.focus() }
          return
        }
        e.preventDefault()
        if (down) this.keys.add(e.code)
        else this.keys.delete(e.code)
      }

      // keyInput reads the keys of one hero. Playing with the Agent, both
      // sets of keys move the person's hero.
      keyInput (kind) {
        const k = this.keys
        const sets = !this.duo
          ? (kind === 'ember' ? { l: ['KeyA'], r: ['KeyD'], j: ['KeyW', 'Space'], u: ['KeyS', 'KeyE'] } : { l: ['ArrowLeft'], r: ['ArrowRight'], j: ['ArrowUp'], u: ['ArrowDown'] })
          : { l: ['KeyA', 'ArrowLeft'], r: ['KeyD', 'ArrowRight'], j: ['KeyW', 'ArrowUp', 'Space'], u: ['KeyS', 'ArrowDown', 'KeyE'] }
        const on = (list) => list.some((c) => k.has(c))
        const use = on(sets.u)
        const edge = use && !this.useEdge[kind]
        this.useEdge[kind] = use
        return { x: (on(sets.r) ? 1 : 0) - (on(sets.l) ? 1 : 0), jump: on(sets.j), use: edge }
      }

      // assist drives the person's hero by the autopilot (the e2e tests
      // use it to play the person's part).
      assist (target, opts = {}) {
        return new Promise((resolve) => {
          if (!this.W) { resolve({ ok: false, text: '没在玩' }); return }
          const kind = opts.kind ?? this.human
          this.assistPilot = new this.E.Pilot(kind)
          this.assistPilot.go(this.W, target, { use: !!opts.use }, (r) => { resolve(r) })
        })
      }

      // ---------------------------------------------------- orders

      exec (cmd) {
        const done = (r) => {
          this.results.push({ id: cmd.id, ok: r.ok, text: r.text })
          if (this.doingId === cmd.id) { this.agentDoing = ''; this.updateChrome() }
        }
        const E = this.E
        if (!this.duo) return done({ ok: false, text: '用户在单人练习，没有给你留角色' })
        if (cmd.action === 'next') {
          // The game may already have moved on by itself after the win.
          if (this.mode === 'play' && this.W?.status === 'playing' && this.wonTo === this.levelId && this.W.tick < 60 * 30) {
            return done({ ok: true, text: `游戏已经自动进入第 ${this.L.id} 关「${this.L.name}」，用 diptych_look 看看新地图` })
          }
          if (this.W?.status !== 'complete') return done({ ok: false, text: '还没过关，不能去下一关' })
          const i = E.LEVELS.findIndex((d) => d.id === this.levelId)
          const next = E.LEVELS[i + 1]
          if (!next) return done({ ok: false, text: '这是最后一关了' })
          this.start(next.id)
          return done({ ok: true, text: `开始第 ${next.id} 关「${next.name}」，用 diptych_look 看看新地图` })
        }
        if (this.mode !== 'play' || !this.W) return done({ ok: false, text: '用户还在选关界面，等他开始' })
        if (cmd.action === 'restart') { this.restart(false); this.addLog('s', 'Agent 重开了这一关'); return done({ ok: true, text: '重开了' }) }
        if (this.W.status === 'complete') return done({ ok: false, text: '已经过关了；可以用 next 去下一关' })
        const p = this.pilot
        const hero = this.W.heroes[this.agentKind]
        const dirN = cmd.dir === 'left' ? -1 : cmd.dir === 'right' ? 1 : 0
        this.doingId = cmd.id
        if (cmd.action === 'stop') { p.cancel('停下了'); this.agentDoing = ''; return done({ ok: true, text: '停下了' }) }
        if (cmd.action === 'go' || cmd.action === 'pull') {
          if (cmd.action === 'pull') {
            const o = this.L.byId.get(String(cmd.target))
            if (o?.type !== 'lever') return done({ ok: false, text: `${cmd.target} 不是拉杆` })
          }
          const t = E.resolveTarget(this.W, this.agentKind, cmd.target)
          this.agentDoing = cmd.action === 'pull' ? `去拉${t.label ?? cmd.target}` : `去${t.label ?? JSON.stringify(cmd.target)}`
          this.updateChrome()
          p.go(this.W, cmd.target, { use: cmd.action === 'pull' }, done)
          return
        }
        if (cmd.action === 'jump') {
          this.agentDoing = '跳'
          p.raw(this.W, { jump: true, dir: dirN, hold: 999 }, done)
          return
        }
        if (cmd.action === 'walk') {
          const c = E.centreCell(hero)
          const n = Math.max(1, Math.min(30, cmd.tiles ?? 1))
          this.agentDoing = `往${dirN < 0 ? '左' : '右'}走`
          p.go(this.W, { x: c.x + dirN * n, y: c.y }, {}, done)
          return
        }
        done({ ok: false, text: `不认识的动作 ${cmd.action}` })
      }

      // ---------------------------------------------------- sync

      async syncNow () {
        if (this.syncing || !this.alive || !this.E) return
        this.syncing = true
        const E = this.E
        let snap = null
        if (this.W && this.mode === 'play') {
          snap = E.snapshot(this.W)
          // What the Agent can reach, recomputed when the world changes.
          if (this.duo) {
            const h = this.W.heroes[this.agentKind]
            const c = E.centreCell(h)
            const key = JSON.stringify([snap.gates, snap.lifts, c, h.ground, snap.taken.length])
            if (key !== this.reachKey && h.ground && performance.now() - this.reachAt > 300) {
              this.reachKey = key
              this.reachAt = performance.now()
              try { this.reach = E.reachable(this.W, this.agentKind) } catch { this.reach = null }
            }
          }
        }
        const body = {
          sessionId: this.sessionId,
          run: this.run,
          claim: this.claim,
          agent: this.duo && this.mode === 'play' ? this.agentKind : null,
          snapshot: snap,
          reach: this.reach,
          events: this.outEvents.splice(0),
          results: this.results.splice(0)
        }
        try {
          const r = await sync(body)
          if (!this.alive) return
          this.syncErr = ''
          if (!!r.standby !== this.standby) {
            this.standby = !!r.standby
            this.addLog('s', this.standby ? '这局游戏在另一个页面里和 Agent 玩着；在这里按键或点一下，就换到这个页面玩' : '换到这个页面了，Agent 跟这里一起玩')
            this.updateChrome()
          }
          if (this.standby) return
          const was = this.agent.active
          this.agent = r.agent ?? this.agent
          this.keepAgent()
          if (was !== this.agent.active) {
            this.updateChrome()
            if (this.agent.active && this.mode === 'play') this.addLog('s', `Agent 进来了，在玩${E.HEROES[this.agentKind].zh}`)
          } else if (this.agent.active) this.updateChrome()
          for (const s of r.said ?? []) {
            this.addLog('agent', s.text)
            if (this.agentKind) this.bubbles[this.agentKind] = { text: s.text, until: performance.now() + 4500 }
          }
          for (const c of r.commands ?? []) this.exec(c)
        } catch (err) {
          // Keep what was not delivered for the next try.
          this.outEvents.unshift(...body.events)
          this.results.unshift(...body.results)
          if (this.outEvents.length > 300) this.outEvents.splice(0, this.outEvents.length - 300)
          this.syncErr = err.message
        } finally {
          this.syncing = false
        }
      }

      // ---------------------------------------------------- loop

      loop () {
        let last = performance.now()
        let acc = 0
        const frame = (now) => {
          if (!this.alive) return
          this.raf = requestAnimationFrame(frame)
          acc += Math.min(0.25, (now - last) / 1000)
          last = now
          const E = this.E
          while (acc >= E.TICK) {
            acc -= E.TICK
            this.tick()
          }
          this.draw(now / 1000)
        }
        this.raf = requestAnimationFrame(frame)
      }

      tick () {
        const W = this.W
        const E = this.E
        if (!W || this.mode !== 'play') return
        const inputs = {}
        if (this.duo) {
          inputs[this.human] = this.assistPilot?.busy ? this.assistPilot.tick(W) : this.keyInput(this.human)
          inputs[this.agentKind] = this.pilot.tick(W)
        } else {
          inputs.ember = this.keyInput('ember')
          inputs.rime = this.keyInput('rime')
        }
        const before = W.status
        E.step(W, inputs)
        this.prepare(this.L)
        this.landingDust()
        for (const ev of W.events) {
          this.outEvents.push(ev)
          this.effects(ev)
          if (ev.type === 'died') this.addLog('s', `${E.HEROES[ev.who].zh}${ev.liquid ? '碰到' + E.LIQUID_ZH[ev.liquid] : '掉了下去'}，倒下了`)
          if (ev.type === 'gem') this.updateGems()
        }
        W.events.length = 0
        if (before === 'playing' && W.status === 'dead') {
          this.pilot?.cancel('有人倒下了，关卡重开')
          this.assistPilot = null
          this.overlay(el('div', { class: 'dp-banner bad' }, `${E.HEROES[W.cause.who].zh}倒下了……`))
        }
        if (W.status === 'dead' && W.tick - W.statusTick > 75) this.restart(false)
        if (before === 'playing' && W.status === 'complete') this.won()
        if (W.tick % 30 === 0) this.clockEl.textContent = `${Math.floor(W.tick * E.TICK)}s`
        if (W.tick % 60 === 0) this.saveRun()
      }

      updateGems () {
        const W = this.W
        if (!W) return
        const n = (k) => `${W.L.gems.filter((g) => g.kind === k && W.taken.has(g.id)).length}/${W.L.gems.filter((g) => g.kind === k).length}`
        this.gemsEl.replaceChildren(el('i', { class: 'e' }), n('ember'), el('i', { class: 'r' }), n('rime'))
      }

      won () {
        const E = this.E
        const W = this.W
        // The Agent was playing this level with the user: the next one
        // carries on with it (see keepAgent).
        this.carry = this.duo && (this.agent.busy || this.agent.waiting || (this.agent.idle != null && this.agent.idle < 30000))
        const i = E.LEVELS.findIndex((d) => d.id === this.levelId)
        const seconds = Math.floor(W.tick * E.TICK)
        const rec = { seconds, gems: W.taken.size, of: W.L.gems.length }
        const prev = this.best[this.levelId]
        if (!prev || rec.gems > prev.gems || (rec.gems === prev.gems && rec.seconds < prev.seconds)) this.best[this.levelId] = rec
        this.unlocked = Math.max(this.unlocked, Math.min(E.LEVELS.length, i + 2))
        const next = E.LEVELS[i + 1]
        // The finished level is no longer something to resume; the menu
        // offers the next one.
        save({ unlocked: this.unlocked, best: this.best, run: null, level: next ? next.id : this.levelId })
        this.addLog('s', `过关！${seconds} 秒，宝石 ${rec.gems}/${rec.of}`)
        this.wonTo = next?.id ?? null
        this.countEl = el('p', { class: 'dp-count' })
        const stay = el('button', { type: 'button', class: 'dp-btn', onclick: () => { this.cancelNext(); stay.remove() } }, '先留在这关')
        this.overlay(el('div', { class: 'dp-card' },
          el('h3', {}, next ? '过关！' : '全部通关！'),
          el('p', {}, `${seconds} 秒 · 宝石 ${rec.gems}/${rec.of}`),
          next ? this.countEl : '',
          el('div', { class: 'dp-row' },
            next ? el('button', { type: 'button', class: 'dp-go', onclick: () => this.start(next.id) }, `下一关：${next.name}`) : '',
            next ? stay : '',
            el('button', { type: 'button', class: 'dp-btn', onclick: () => this.start(this.levelId) }, '再玩一次'),
            el('button', { type: 'button', class: 'dp-btn', onclick: () => this.toMenu() }, '选关'))))
        if (next) this.scheduleNext(next)
      }

      // ---------------------------------------------------- render

      // prepare works out what drawing a level needs: the link colours, the
      // runs of liquid, a fresh particle list.
      prepare (L) {
        if (this.prepared === L) return
        this.prepared = L
        // Each button or lever's colour (engine.links); the gates and lifts
        // it drives show lamps in it, so who opens what reads at a glance.
        this.links = new Map([...this.E.links(L)].map(([id, c]) => [id, c.hex]))
        this.runs = []
        for (let y = 0; y < L.h; y++) {
          for (let x = 0; x < L.w;) {
            const kind = L.liquid[y * L.w + x]
            if (!kind) { x++; continue }
            let x1 = x
            while (x1 + 1 < L.w && L.liquid[y * L.w + x1 + 1] === kind) x1++
            this.runs.push({ kind, x0: x, x1, y })
            x = x1 + 1
          }
        }
        this.fx = []
        this.wasGround = {}
        this.staticLayer = null
      }

      // burst throws particles from a point (in tiles).
      burst (x, y, color, n, o = {}) {
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2
          const sp = (o.speed ?? 3) * (0.35 + Math.random() * 0.8)
          this.fx.push({
            x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (o.up ?? 1.5), g: o.g ?? 6, life: 0,
            max: (o.life ?? 0.8) * (0.6 + Math.random() * 0.7), color: Array.isArray(color) ? color[i % color.length] : color,
            size: (o.size ?? 0.07) * (0.6 + Math.random() * 0.8), kind: o.kind ?? 'spark', spin: Math.random() * 6
          })
        }
        if (this.fx.length > 500) this.fx.splice(0, this.fx.length - 500)
      }

      // effects turns world events into particles.
      effects (ev) {
        const L = this.L
        const W = this.W
        if (!L || !W || !this.links) return
        const heroC = (k) => (k === 'ember' ? [PAL.ember, PAL.emberHi] : [PAL.rime, PAL.rimeHi])
        if (ev.type === 'gem') {
          const gem = L.gems.find((g) => g.id === ev.id)
          if (gem) {
            this.burst(gem.x + 0.5, gem.y + 0.5, [...heroC(gem.kind), '#ffffff'], 18, { speed: 3.5, up: 0.6, g: 2.5, life: 0.7 })
            this.fx.push({ x: gem.x + 0.5, y: gem.y + 0.5, life: 0, max: 0.45, color: heroC(gem.kind)[1], kind: 'ring', size: 0.9 })
          }
        } else if (ev.type === 'died') {
          const h = W.heroes[ev.who]
          const c = ev.liquid ? [LIQ[ev.liquid].glow, LIQ[ev.liquid].top] : heroC(ev.who)
          this.burst(h.x + 0.35, h.y + 0.5, c, 30, { speed: 4.5, up: 2.5, g: 9, life: 0.9, size: 0.09 })
          this.burst(h.x + 0.35, h.y + 0.4, '#b9b6cc', 10, { speed: 0.8, up: 0.8, g: -0.6, life: 1.4, size: 0.2, kind: 'smoke' })
        } else if (ev.type === 'lever') {
          const l = L.byId.get(ev.id)
          if (l) this.burst(l.x + 0.5, l.y + 0.4, [PAL.brass, this.links.get(l.id)], 10, { speed: 2.5, up: 1, g: 7, life: 0.5, size: 0.05 })
        } else if (ev.type === 'button' && ev.on) {
          const b = L.byId.get(ev.id)
          if (b) this.burst(b.x + 0.5, b.y + 0.85, this.links.get(b.id), 8, { speed: 1.8, up: 0.8, g: 3, life: 0.5, size: 0.05 })
        } else if (ev.type === 'exit' && ev.at) {
          const ex = L.exits[ev.who]
          this.fx.push({ x: ex.x + 0.5, y: ex.y + 0.2, life: 0, max: 0.6, color: heroC(ev.who)[0], kind: 'ring', size: 1.3 })
        } else if (ev.type === 'complete') {
          for (const k of ['ember', 'rime']) {
            const ex = L.exits[k]
            this.burst(ex.x + 0.5, ex.y, [...heroC(k), '#ffe08a', '#ffffff'], 40, { speed: 6, up: 4, g: 7, life: 1.6, size: 0.12, kind: 'confetti' })
          }
        }
      }

      landingDust () {
        const W = this.W
        if (!W) return
        for (const k of ['ember', 'rime']) {
          const h = W.heroes[k]
          const g = !!h.ground && h.alive
          if (g && this.wasGround[k] === false) this.burst(h.x + 0.35, h.y + 0.9, 'rgba(210,205,235,1)', 5, { speed: 1.2, up: 0.2, g: -0.5, life: 0.4, size: 0.07, kind: 'smoke' })
          this.wasGround[k] = g
        }
      }

      draw (t) {
        const c = this.canvas
        const g = c.getContext('2d')
        if (!g || !this.T) return
        const T = this.T
        const E = this.E
        g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
        const L = this.L
        const Wd = (L?.w ?? 28) * T
        const Hd = (L?.h ?? 12) * T
        if (!L) {
          g.fillStyle = PAL.bg1
          g.fillRect(0, 0, Wd, Hd)
          return
        }
        this.prepare(L)
        const dt = Math.min(0.05, Math.max(0, t - (this.lastT ?? t)))
        this.lastT = t
        if (!this.staticLayer || this.staticFor !== L) this.paintStatic()
        g.drawImage(this.staticLayer, 0, 0, Wd, Hd)
        const W = this.W
        const s = W ?? (this.preview?.L === L ? this.preview : (this.preview = E.createWorld(L)))
        this.drawLiquids(g, T, t, dt)
        for (const k of ['ember', 'rime']) drawExit(g, k, L.exits[k].x * T, L.exits[k].y * T, T, s.heroes[k].atExit, t)
        this.drawMachines(g, T, t, s)
        for (const gem of L.gems) if (!s.taken.has(gem.id)) drawGem(g, gem.kind, gem.x * T, gem.y * T, T, t)
        for (const k of ['ember', 'rime']) {
          const h = s.heroes[k]
          if (h.alive && W && this.mode === 'play' && Math.random() < dt * (k === 'ember' ? 16 : 8)) {
            if (k === 'ember') this.fx.push({ x: h.x + 0.2 + Math.random() * 0.3, y: h.y - 0.1, vx: (Math.random() - 0.5) * 0.6, vy: -1.2 - Math.random(), g: -0.5, life: 0, max: 0.5 + Math.random() * 0.4, color: Math.random() < 0.5 ? PAL.emberHi : PAL.ember, size: 0.04 + Math.random() * 0.03, kind: 'spark' })
            else this.fx.push({ x: h.x + Math.random() * 0.7, y: h.y + 0.2 + Math.random() * 0.5, vx: (Math.random() - 0.5) * 0.5, vy: 0.3 + Math.random() * 0.3, g: 0, life: 0, max: 0.8 + Math.random() * 0.5, color: '#ffffff', size: 0.05 + Math.random() * 0.03, kind: 'flake' })
          }
          drawHero(g, k, h.x * T, h.y * T, T, t, { facing: h.facing, dead: !h.alive, vx: h.vx, vy: h.vy, ground: !!h.ground })
        }
        this.drawFx(g, T, dt)
        g.drawImage(this.vignette, 0, 0, Wd, Hd)
        if (this.duo && this.mode === 'play') {
          // Name tags; when the heroes stand close, the tags step apart.
          const gap = s.heroes.ember.x - s.heroes.rime.x
          const near = Math.abs(gap) < 1.3 && Math.abs(s.heroes.ember.y - s.heroes.rime.y) < 0.8
          const push = near ? (1.3 - Math.abs(gap)) / 2 * (gap < 0 ? -1 : 1) : 0
          for (const k of ['ember', 'rime']) {
            const h = s.heroes[k]
            if (!h.alive) continue
            const mine = k !== this.agentKind
            const dx = k === 'ember' ? push : -push
            this.pill(g, mine ? '你' : 'Agent', (h.x + 0.35 + dx) * T, (h.y - 0.62) * T, Math.max(9, Math.round(T * 0.32)), mine ? 'rgba(255,255,255,.18)' : (k === 'ember' ? rgba(PAL.ember, 0.55) : rgba(PAL.rime, 0.55)), '#fff')
          }
        }
        const now = performance.now()
        for (const k of ['ember', 'rime']) {
          const b = this.bubbles[k]
          if (!b || b.until < now) continue
          this.bubble(g, b.text, (s.heroes[k].x + 0.35) * T, (s.heroes[k].y - 1.05) * T, T, Wd)
        }
        this.pings = this.pings.filter((p) => now - p.at < 1800)
        for (const p of this.pings) {
          const a = (now - p.at) / 1800
          const cx = (p.x + 0.5) * T
          const cy = (p.y + 0.5) * T
          g.strokeStyle = `rgba(255,230,120,${1 - a})`
          g.lineWidth = 2
          for (const d of [0, 0.35]) {
            const r = ((a + d) % 1) * 1.1 * T + 0.2 * T
            g.beginPath()
            g.arc(cx, cy, r, 0, Math.PI * 2)
            g.stroke()
          }
          g.fillStyle = `rgba(255,230,120,${1 - a})`
          g.beginPath()
          g.moveTo(cx, cy - 0.55 * T - Math.sin(a * 12) * 0.08 * T)
          g.lineTo(cx + 0.16 * T, cy - 0.85 * T)
          g.lineTo(cx - 0.16 * T, cy - 0.85 * T)
          g.closePath()
          g.fill()
        }
        if (this.mode === 'play' && W && W.tick % 30 === 1) this.updateGems()
      }

      drawLiquids (g, T, t, dt) {
        for (const r of this.runs) {
          const c = LIQ[r.kind]
          const base = (r.y + 1) * T
          const surf = (px) => (r.y + 0.44 + Math.sin(t * 2.6 + px * 2.1) * 0.035 + Math.sin(t * 1.7 - px * 3.3) * 0.02) * T
          for (let x = r.x0; x <= r.x1; x++) drawGlow(g, c.glow, (x + 0.5) * T, (r.y + 0.45) * T, T * 1.15, r.kind === 'frost' ? 0.2 : 0.3)
          const steps = (r.x1 - r.x0 + 1) * 4
          const grad = g.createLinearGradient(0, (r.y + 0.4) * T, 0, base)
          grad.addColorStop(0, c.top)
          grad.addColorStop(0.3, c.mid)
          grad.addColorStop(1, c.deep)
          g.fillStyle = grad
          g.beginPath()
          g.moveTo(r.x0 * T, base)
          for (let i = 0; i <= steps; i++) g.lineTo((r.x0 + i / 4) * T, surf(r.x0 + i / 4))
          g.lineTo((r.x1 + 1) * T, base)
          g.closePath()
          g.fill()
          g.strokeStyle = rgba(c.fleck, 0.7)
          g.lineWidth = Math.max(1, T * 0.05)
          g.beginPath()
          for (let i = 0; i <= steps; i++) {
            const px = r.x0 + i / 4
            if (i) g.lineTo(px * T, surf(px))
            else g.moveTo(px * T, surf(px))
          }
          g.stroke()
          for (let x = r.x0; x <= r.x1; x++) {
            const hs = hash(x, r.y, 3)
            if (r.kind === 'frost') {
              const tw = (t * 0.45 + hs) % 1
              if (tw < 0.22) star(g, (x + 0.2 + hs * 0.6) * T, (r.y + 0.66 + hs * 0.18) * T, T * 0.11 * Math.sin(tw / 0.22 * Math.PI), '#ffffff', 0.9)
            } else {
              const p = (t * (r.kind === 'lava' ? 0.55 : 0.4) + hs) % 1
              const top = surf(x + 0.5)
              g.fillStyle = rgba(c.top, 0.85 * (1 - p * 0.4))
              g.beginPath()
              g.arc((x + 0.25 + hs * 0.5) * T, base - p * (base - top) - T * 0.04, T * (0.035 + 0.045 * p), 0, Math.PI * 2)
              g.fill()
            }
            if (dt && Math.random() < dt * (r.kind === 'lava' ? 0.55 : 0.18)) {
              this.fx.push({
                x: x + Math.random(), y: r.y + 0.45, vx: (Math.random() - 0.5) * 0.3, vy: -(0.5 + Math.random() * 0.8), g: r.kind === 'lava' ? 0.3 : 0,
                life: 0, max: 1 + Math.random(), color: r.kind === 'lava' ? (Math.random() < 0.5 ? c.fleck : c.glow) : c.fleck,
                size: 0.03 + Math.random() * 0.03, kind: r.kind === 'frost' ? 'flake' : 'spark'
              })
            }
          }
        }
      }

      drawMachines (g, T, t, s) {
        const L = this.L
        const col = (id) => this.links.get(id) ?? '#ffffff'
        const on = (id) => s.levers[id] === true || s.buttons[id] === true
        for (const l of L.lifts) {
          const y = s.lifts[l.id]
          const top = Math.min(l.y, l.y + l.dy)
          const bot = Math.max(l.y, l.y + l.dy)
          g.strokeStyle = 'rgba(167,176,211,.22)'
          g.lineWidth = Math.max(1, T * 0.06)
          for (const rx of [l.x + 0.12, l.x + l.w - 0.12]) {
            g.beginPath()
            g.moveTo(rx * T, (top - 0.4) * T)
            g.lineTo(rx * T, (bot + 0.5) * T)
            g.stroke()
          }
          g.save()
          g.setLineDash([T * 0.12, T * 0.08])
          g.strokeStyle = 'rgba(200,205,230,.55)'
          g.lineWidth = Math.max(1, T * 0.05)
          for (const rx of [l.x + 0.3, l.x + l.w - 0.3]) {
            g.beginPath()
            g.moveTo(rx * T, (top - 0.4) * T)
            g.lineTo(rx * T, y * T)
            g.stroke()
          }
          g.restore()
          g.drawImage(art.lift, l.x * T, y * T, l.w * T, 0.5 * T)
          l.by.forEach((id, i) => lamp(g, col(id), (l.x + 0.35 + i * 0.3) * T, (y + 0.3) * T, T * 0.07, on(id)))
          this.tag(g, l.id, (l.x + l.w - 0.4) * T, (y + 0.28) * T)
        }
        for (const gt of L.gates) {
          const f = s.gates[gt.id]
          const x = gt.x * T
          const y = gt.y * T
          const w = gt.w * T
          if (gt.w > gt.h) {
            // Flat gates: a wooden bridge (invert) or an iron trapdoor that
            // slides away.
            const hh = gt.h * (1 - f) * T
            if (hh > 0.5) {
              tileFill(g, gt.invert ? art.plank : art.slab, x, y, w, hh, T)
              if (gt.invert) drawGlow(g, col(gt.by[0]), x + w / 2, y, w * 0.6, 0.25)
            } else {
              g.save()
              g.setLineDash([T * 0.16, T * 0.12])
              g.strokeStyle = rgba(col(gt.by[0]), 0.55)
              g.lineWidth = Math.max(1, T * 0.05)
              g.strokeRect(x + 1, y + 1, w - 2, gt.h * T - 2)
              g.restore()
            }
            gt.by.forEach((id, i) => lamp(g, col(id), x + (0.25 + i * 0.3) * T, y - 0.18 * T, T * 0.07, on(id)))
            this.tag(g, gt.id, x + w - 0.3 * T, y - 0.22 * T)
            continue
          }
          // Upright gates: a portcullis that rises into its housing.
          const H = gt.h * T
          const hp = H * (1 - f)
          if (hp > 0.5) {
            const img = art.portcullis
            const sh = img.height * hp / H
            g.drawImage(img, 0, img.height - sh, img.width, sh, x, y, w, hp)
          }
          g.fillStyle = PAL.ironLo
          roundRect(g, x - 0.08 * T, y - 0.14 * T, w + 0.16 * T, 0.18 * T, T * 0.05)
          g.fill()
          g.fillStyle = PAL.brass
          g.fillRect(x - 0.04 * T, y - 0.13 * T, w + 0.08 * T, Math.max(1, T * 0.035))
          gt.by.forEach((id, i) => lamp(g, col(id), x + w / 2 + (i - (gt.by.length - 1) / 2) * 0.28 * T, y - 0.3 * T, T * 0.075, on(id)))
          this.tag(g, gt.id, x + w / 2, y - 0.62 * T)
        }
        for (const b of L.buttons) {
          const pressed = s.buttons[b.id]
          const c = col(b.id)
          const bx = b.x * T
          const by = (b.y + 1) * T
          const pw = 0.92 * T
          const ph = pw * art.plate.height / art.plate.width
          // The coloured pad sits in the housing and sinks when stood on.
          const rise = pressed ? 0.02 : 0.11
          g.fillStyle = pressed ? c : rgba(c, 0.7)
          roundRect(g, bx + 0.2 * T, by - ph - rise * T, 0.6 * T, ph * 0.6 + rise * T, T * 0.05)
          g.fill()
          g.fillStyle = 'rgba(255,255,255,.4)'
          g.fillRect(bx + 0.26 * T, by - ph - rise * T, 0.48 * T, Math.max(1, T * 0.03))
          g.drawImage(art.plate, bx + (T - pw) / 2, by - ph, pw, ph)
          if (pressed) drawGlow(g, c, bx + 0.5 * T, by - 0.2 * T, T, 0.7)
          this.tag(g, b.id, bx + 0.5 * T, by - 0.62 * T)
        }
        for (const l of L.levers) {
          const pulled = s.levers[l.id]
          const c = col(l.id)
          const base = art['lever-base']
          const handle = art['lever-handle']
          const bw = 0.62 * T
          const bh = bw * base.height / base.width
          const len = 0.78 * T
          const hw = len * handle.width / handle.height
          const px = (l.x + 0.5) * T
          const py = (l.y + 1) * T - bh * 0.55
          const a = pulled ? 0.7 : -0.7
          g.save()
          g.translate(px, py)
          g.rotate(a)
          g.drawImage(handle, -hw / 2, -len, hw, len)
          // The knob wears the lever's colour.
          g.fillStyle = rgba(c, pulled ? 0.85 : 0.55)
          g.beginPath()
          g.arc(0, -len + hw * 0.42, hw * 0.4, 0, Math.PI * 2)
          g.fill()
          g.restore()
          g.drawImage(base, px - bw / 2, (l.y + 1) * T - bh, bw, bh)
          if (pulled) drawGlow(g, c, px + Math.sin(a) * len * 0.92, py - Math.cos(a) * len * 0.92, T * 0.8, 0.6)
          this.tag(g, l.id, px, (l.y + 1) * T - 0.2 * T, true)
        }
      }

      drawFx (g, T, dt) {
        const keep = []
        for (const p of this.fx) {
          p.life += dt
          if (p.life >= p.max) continue
          keep.push(p)
          if (p.kind !== 'ring') {
            p.vy += (p.g ?? 0) * dt
            p.x += (p.vx ?? 0) * dt
            p.y += (p.vy ?? 0) * dt
          }
          const a = 1 - p.life / p.max
          const x = p.x * T
          const y = p.y * T
          if (p.kind === 'spark') {
            g.save()
            g.globalCompositeOperation = 'lighter'
            g.globalAlpha = a
            g.fillStyle = p.color
            g.beginPath()
            g.arc(x, y, Math.max(0.6, p.size * T), 0, Math.PI * 2)
            g.fill()
            g.restore()
          } else if (p.kind === 'flake') {
            star(g, x, y, Math.max(1, p.size * T * 1.4), p.color, a * 0.85)
          } else if (p.kind === 'smoke') {
            g.fillStyle = `rgba(185,182,204,${a * 0.35})`
            g.beginPath()
            g.arc(x, y, p.size * T * (1.6 - a * 0.6), 0, Math.PI * 2)
            g.fill()
          } else if (p.kind === 'ring') {
            g.strokeStyle = rgba(p.color.startsWith('#') ? p.color : '#ffffff', a)
            g.lineWidth = Math.max(1, T * 0.07)
            g.beginPath()
            g.arc(x, y, (1 - a) * p.size * T + 0.1 * T, 0, Math.PI * 2)
            g.stroke()
          } else if (p.kind === 'confetti') {
            p.spin += dt * 8
            g.save()
            g.globalAlpha = Math.min(1, a * 1.5)
            g.translate(x, y)
            g.rotate(p.spin)
            g.fillStyle = p.color
            g.fillRect(-p.size * T * 0.6, -p.size * T * 0.25, p.size * T * 1.2, p.size * T * 0.5)
            g.restore()
          }
        }
        this.fx = keep
      }

      tag (g, text, cx, cy, low) {
        const T = this.T
        if (T < 9) return
        this.pill(g, text, cx, cy + (low ? 0.08 * T : 0), Math.max(9, Math.round(T * 0.3)), 'rgba(12,10,28,.72)', 'rgba(255,240,205,.95)', true)
      }

      pill (g, text, cx, cy, fs, bg, fg, mono) {
        g.font = `700 ${fs}px ${mono ? 'ui-monospace, Menlo, monospace' : '-apple-system, "PingFang SC", sans-serif'}`
        const tw = g.measureText(text).width
        const w = tw + fs * 0.7
        const h = fs * 1.3
        g.fillStyle = bg
        roundRect(g, cx - w / 2, cy - h / 2, w, h, h / 2)
        g.fill()
        g.fillStyle = fg
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(text, cx, cy + fs * 0.05)
        g.textBaseline = 'alphabetic'
      }

      bubble (g, text, cx, by, T, Wd) {
        const fs = Math.max(11, Math.round(T * 0.42))
        g.font = `500 ${fs}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`
        const tw = Math.min(g.measureText(text).width, T * 9)
        const w = tw + fs * 1.2
        const h = fs * 1.7
        const x = Math.max(2, Math.min(Wd - w - 2, cx - w / 2))
        const y = Math.max(2, by - h)
        g.save()
        g.shadowColor = 'rgba(0,0,0,.35)'
        g.shadowBlur = 8
        g.fillStyle = 'rgba(255,255,255,.95)'
        roundRect(g, x, y, w, h, h / 2.4)
        g.fill()
        g.restore()
        g.fillStyle = 'rgba(255,255,255,.95)'
        g.beginPath()
        g.moveTo(cx - 5, y + h - 1)
        g.lineTo(cx, y + h + 6)
        g.lineTo(cx + 5, y + h - 1)
        g.fill()
        g.fillStyle = '#1b1f33'
        g.textAlign = 'left'
        g.textBaseline = 'middle'
        let str = text
        while (g.measureText(str).width > tw && str.length > 1) str = str.slice(0, -2) + '…'
        g.fillText(str, x + fs * 0.6, y + h / 2)
        g.textBaseline = 'alphabetic'
      }

      // paintStatic draws the backdrop, the walls and the ledges once per
      // level and size, and the vignette laid over everything.
      paintStatic () {
        const L = this.L
        const T = this.T
        const Wd = L.w * T
        const Hd = L.h * T
        const off = document.createElement('canvas')
        off.width = Math.round(Wd * this.dpr)
        off.height = Math.round(Hd * this.dpr)
        const g = off.getContext('2d')
        g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
        // The chapter's painted backdrop covers the room, dimmed so the
        // heroes and machines read in front of it.
        const ci = Math.max(0, this.E.CHAPTERS.findLastIndex((c) => Number(L.id) >= c.from))
        const theme = THEMES[ci % THEMES.length]
        const bg = art[theme.bg]
        const sc = Math.max(Wd / bg.width, Hd / bg.height)
        g.drawImage(bg, (Wd - bg.width * sc) / 2, (Hd - bg.height * sc) / 2, bg.width * sc, bg.height * sc)
        g.fillStyle = 'rgba(14,11,32,.5)'
        g.fillRect(0, 0, Wd, Hd)
        const solid = (x, y) => x < 0 || y < 0 || x >= L.w || y >= L.h || L.solid[y * L.w + x] === 1
        const walls = () => {
          g.beginPath()
          for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) if (solid(x, y)) g.rect(x * T, y * T, T, T)
        }
        // Walls cast a soft shadow on the backdrop.
        g.save()
        g.shadowColor = 'rgba(0,0,0,.6)'
        g.shadowBlur = T * 0.6
        g.fillStyle = PAL.mortar
        walls()
        g.fill()
        g.restore()
        // The stone: the chapter's texture, two courses to a tile so the
        // joints meet the tile edges.
        const tex = art[theme.wall]
        const pat = g.createPattern(tex, 'repeat')
        pat.setTransform(new DOMMatrix().scale(T / tex.height))
        g.fillStyle = pat
        walls()
        g.fill()
        for (let y = 0; y < L.h; y++) {
          for (let x = 0; x < L.w; x++) {
            if (!solid(x, y)) continue
            const px = x * T
            const py = y * T
            const open = { u: !solid(x, y - 1), d: !solid(x, y + 1), l: !solid(x - 1, y), r: !solid(x + 1, y) }
            if (!open.u && !open.d && !open.l && !open.r) {
              g.fillStyle = 'rgba(0,0,0,.28)'
              g.fillRect(px, py, T, T)
            }
            if (open.u) {
              const cap = g.createLinearGradient(0, py, 0, py + T * 0.22)
              cap.addColorStop(0, 'rgba(255,255,255,.22)')
              cap.addColorStop(1, 'rgba(255,255,255,0)')
              g.fillStyle = cap
              g.fillRect(px, py, T, T * 0.22)
              g.fillStyle = 'rgba(255,255,255,.3)'
              g.fillRect(px, py, T, Math.max(1, T * 0.04))
              // A few crystals grow on top: warm on the left, cool on the right.
              if (hash(x, y, 7) < 0.18 && !L.liquid[(y - 1) * L.w + x]) {
                const warm = x < L.w / 2
                g.fillStyle = warm ? 'rgba(255,150,90,.8)' : 'rgba(120,200,255,.8)'
                const bx = px + T * (0.2 + hash(x, y, 8) * 0.5)
                g.beginPath()
                g.moveTo(bx, py)
                g.lineTo(bx + T * 0.07, py - T * 0.22)
                g.lineTo(bx + T * 0.14, py)
                g.moveTo(bx + T * 0.12, py)
                g.lineTo(bx + T * 0.2, py - T * 0.13)
                g.lineTo(bx + T * 0.26, py)
                g.fill()
              }
            }
            if (open.d) {
              g.fillStyle = 'rgba(0,0,0,.35)'
              g.fillRect(px, py + T * 0.86, T, T * 0.14)
            }
            if (open.l) {
              g.fillStyle = 'rgba(255,255,255,.08)'
              g.fillRect(px, py, Math.max(1, T * 0.07), T)
            }
            if (open.r) {
              g.fillStyle = 'rgba(0,0,0,.25)'
              g.fillRect(px + T - Math.max(1, T * 0.07), py, Math.max(1, T * 0.07), T)
            }
          }
        }
        // Ledges: a wooden plank to a cell.
        const plank = art.plank
        const ph = T * plank.height / plank.width
        for (let y = 0; y < L.h; y++) {
          for (let x = 0; x < L.w; x++) {
            if (!L.ledge[y * L.w + x]) continue
            g.fillStyle = 'rgba(0,0,0,.3)'
            g.fillRect(x * T + 1, y * T + ph * 0.9, T - 2, Math.max(1, T * 0.06))
            g.drawImage(plank, x * T, y * T, T, ph)
          }
        }
        // The diptych: warm light from the left, cool from the right.
        g.save()
        g.globalCompositeOperation = 'soft-light'
        const tint = g.createLinearGradient(0, 0, Wd, 0)
        tint.addColorStop(0, 'rgba(255,140,80,.55)')
        tint.addColorStop(0.5, 'rgba(160,140,200,.15)')
        tint.addColorStop(1, 'rgba(80,170,255,.55)')
        g.fillStyle = tint
        g.fillRect(0, 0, Wd, Hd)
        g.restore()
        this.staticLayer = off
        this.staticFor = L
        const v = document.createElement('canvas')
        v.width = Math.round(Wd * this.dpr)
        v.height = Math.round(Hd * this.dpr)
        const vg = v.getContext('2d')
        vg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
        const rg = vg.createRadialGradient(Wd / 2, Hd / 2, Math.min(Wd, Hd) * 0.35, Wd / 2, Hd / 2, Math.max(Wd, Hd) * 0.75)
        rg.addColorStop(0, 'rgba(0,0,0,0)')
        rg.addColorStop(1, 'rgba(0,0,0,.45)')
        vg.fillStyle = rg
        vg.fillRect(0, 0, Wd, Hd)
        this.vignette = v
      }
    }

    // ------------------------------------------------------------ styles

    const CSS = `
.diptych-host{position:absolute;inset:0;display:flex}
.dp{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;outline:none;overflow:auto;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-base,#fff)}
.dp-top{display:flex;align-items:center;gap:10px;min-height:28px}
.dp-title{font-weight:650;font-size:14px}
.dp-clock{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#59636e)}
.dp-gems{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary,#59636e);font-variant-numeric:tabular-nums}
.dp-gems i{display:inline-block;width:8px;height:8px;transform:rotate(45deg);margin:0 2px 0 6px;border-radius:1px}
.dp-gems i.e{background:#ff8a45}.dp-gems i.r{background:#5cc8ff}
.dp-sp{flex:1}
.dp-btn{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer}
.dp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dp-btn[hidden]{display:none}
.dp-stage{position:relative;display:flex;align-items:center;justify-content:center;flex:none;border-radius:14px;overflow:hidden;background:radial-gradient(120% 90% at 0% 100%,rgba(255,120,60,.18),transparent 60%),radial-gradient(120% 90% at 100% 0%,rgba(80,170,255,.18),transparent 60%),#0b0a17;min-height:160px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
.dp-stage.tall{min-height:560px}
.dp-canvas{display:block;image-rendering:auto;cursor:crosshair}
.dp-ov{position:absolute;inset:0;display:flex;align-items:safe center;justify-content:center;overflow:auto;padding:12px;background:rgba(8,7,20,.5);backdrop-filter:blur(3px)}
.dp-ov[hidden]{display:none}
.dp-hint{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);padding:5px 12px;border-radius:999px;background:rgba(255,255,255,.9);color:#1b1f33;font-size:12px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.dp-hint[hidden]{display:none}
.dp-card{position:relative;max-width:460px;width:100%;padding:14px 16px;border-radius:16px;background:linear-gradient(180deg,rgba(32,27,58,.94),rgba(16,14,32,.94));color:#eef1ff;box-shadow:0 14px 44px rgba(0,0,0,.5),inset 0 0 0 1px rgba(255,255,255,.08);text-align:center}
.dp-card::before{content:"";position:absolute;left:18px;right:18px;top:0;height:2px;border-radius:2px;background:linear-gradient(90deg,#ff7a3d,#ffd166 45%,#a6e6ff 55%,#5cc8ff)}
.dp-brand{display:flex;align-items:center;justify-content:center;gap:10px}
.dp-brand i{width:9px;height:9px;transform:rotate(45deg);border-radius:2px}
.dp-brand i.e{background:#ff7a3d;box-shadow:0 0 10px #ff7a3d}.dp-brand i.r{background:#5cc8ff;box-shadow:0 0 10px #5cc8ff}
.dp-card h2{margin:0;font-size:22px;letter-spacing:.14em;background:linear-gradient(90deg,#ffb27a,#fff,#9fdcff);-webkit-background-clip:text;background-clip:text;color:transparent}
.dp-card h3{margin:0 0 4px;font-size:18px}
.dp-card p{margin:4px 0;color:#c4c9e4}
.dp-sub{font-size:12.5px}
.dp-note{font-size:12px;color:#9aa1c4!important}
.dp-pick{display:flex;align-items:stretch;justify-content:center;gap:10px;margin:8px 0 4px}
.dp-hero{display:flex;flex-direction:column;align-items:center;gap:0;width:124px;padding:3px 6px 6px;border:1.5px solid rgba(255,255,255,.1);border-radius:14px;background:rgba(255,255,255,.035);color:inherit;font:inherit;cursor:pointer;transition:border-color .15s,background .15s,transform .15s}
.dp-hero:hover{border-color:rgba(255,255,255,.3);transform:translateY(-1px)}
.dp-hero.ember.on{border-color:#ff9a5c;background:radial-gradient(100% 80% at 50% 30%,rgba(255,122,61,.22),rgba(255,122,61,.04))}
.dp-hero.rime.on{border-color:#7fd6ff;background:radial-gradient(100% 80% at 50% 30%,rgba(92,200,255,.22),rgba(92,200,255,.04))}
.dp-hero small{color:#9aa1c4;font-size:11px}
.dp-hc{width:52px;height:52px}
.dp-seg{display:inline-flex;margin:6px 0;padding:2px;border-radius:9px;background:rgba(255,255,255,.08)}
.dp-seg button{height:26px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:#c4c9e4;font:inherit;font-size:12.5px;cursor:pointer}
.dp-seg button.on{background:rgba(255,255,255,.16);color:#fff}
.dp-tabs{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin:8px 0 4px}
.dp-tab{display:flex;flex-direction:column;align-items:center;padding:5px 2px;border:0;border-bottom:2px solid transparent;border-radius:8px 8px 4px 4px;background:rgba(255,255,255,.04);color:#c4c9e4;font:inherit;cursor:pointer}
.dp-tab b{font-size:12.5px;font-weight:650}
.dp-tab small{font-size:10.5px;color:#8f96bb;font-variant-numeric:tabular-nums}
.dp-tab.on{background:rgba(255,255,255,.1);color:#fff;border-bottom-color:#ffd166}
.dp-tab:disabled{opacity:.4;cursor:default}
.dp-levels{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:6px 0 8px}
.dp-lv{position:relative;display:flex;align-items:center;gap:7px;min-width:0;padding:5px 8px;border:1.5px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.04);color:inherit;font:inherit;text-align:left;cursor:pointer}
.dp-lv b{flex:none;width:22px;height:22px;display:grid;place-items:center;border-radius:6px;background:rgba(255,255,255,.08);font-size:11.5px;font-variant-numeric:tabular-nums}
.dp-lv span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.dp-lv i{flex:none;font-style:normal;font-size:11px;color:#7ae582}
.dp-lv.all i{color:#ffd166}
.dp-lv.done b{background:rgba(122,229,130,.18);color:#bff3c4}
.dp-lv:hover:not(:disabled){border-color:rgba(255,255,255,.28)}
.dp-lv.on{border-color:#ffd166;background:rgba(255,209,102,.1)}
.dp-lv:disabled{opacity:.38;cursor:default}
.dp-info{margin:2px 0 8px;padding:7px 10px;border-radius:10px;background:rgba(0,0,0,.22);text-align:left}
.dp-info-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px}
.dp-info-h b{font-size:13.5px}
.dp-info-h span{color:#8f96bb;font-size:11.5px}
.dp-info-h small{margin-left:auto;color:#ffd166;font-size:11px}
.dp-info details{margin-top:4px;font-size:12px}
.dp-info summary{cursor:pointer;color:#9aa1c4;width:max-content}
.dp-info details p{margin:4px 0 0;font-size:12px;line-height:1.55}
.dp-go{height:36px;padding:0 24px;border:0;border-radius:10px;background:linear-gradient(90deg,#ff7a3d,#ffb36b 48%,#8fd8ff 52%,#5cc8ff);color:#1a1530;font:inherit;font-weight:700;font-size:14px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.3)}
.dp-go:hover{filter:brightness(1.08)}
.dp-row{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:10px}
.dp-row .dp-btn{color:#eef1ff;border-color:rgba(255,255,255,.25);height:36px}
.dp-count{margin:2px 0 0;font-size:12.5px;color:#ffd98a!important;font-variant-numeric:tabular-nums}
.dp-count:empty{display:none}
.dp-banner{padding:10px 18px;border-radius:12px;background:rgba(20,18,40,.92);color:#fff;font-size:15px;font-weight:600}
.dp-banner.bad{color:#ffb4a2}
.dp-agent{display:flex;align-items:center;gap:8px;min-height:30px;padding:4px 6px 4px 10px;border-radius:9px;background:var(--dsw-alias-bg-l1,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#59636e);font-size:12.5px}
.dp-agent.on{color:var(--dsw-alias-label-primary,#1f2328)}
.dp-agent>span:last-of-type{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dp-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#3fb950;box-shadow:0 0 0 3px rgba(63,185,80,.2);animation:dp-pulse 1.6s ease-in-out infinite}
@keyframes dp-pulse{50%{box-shadow:0 0 0 6px rgba(63,185,80,0)}}
.dp-invite{flex:none;height:26px;padding:0 12px;border:0;border-radius:7px;background:#4f6bff;color:#fff;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.dp-invite:hover{background:#3d58ea}
.dp-chat{display:flex;flex-direction:column;gap:6px;flex:1;min-height:0}
.dp-log{flex:1;min-height:88px;overflow-y:auto;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:9px;font-size:12.5px;scrollbar-width:thin}
.dp-l{padding:1px 0;word-break:break-word}
.dp-l b{font-weight:600}
.dp-l.a b{color:#2f7fd6}.dp-l.m b{color:#d0622a}
.dp-l.s{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:12px}
.dp-quick{display:flex;flex-wrap:wrap;gap:5px}
.dp-quick[hidden]{display:none}
.dp-q{height:24px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:12px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dp-q:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dp-in{height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:9px;background:transparent;color:inherit;font:inherit;outline:none}
.dp-in:focus{border-color:#4f6bff}
.dp-in:disabled{opacity:.5}
.dp-help{color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11.5px}
`

    let styled = false
    function injectStyles () {
      if (styled || document.getElementById('diptych-css')) { styled = true; return }
      document.head.append(el('style', { id: 'diptych-css' }, CSS))
      styled = true
    }

    // ------------------------------------------------------------ tab

    function DiptychBody (props) {
      const ref = useRef(null)
      useEffect(() => {
        if (!ref.current || !props.sessionId) return
        const g = new Game(ref.current, props.sessionId)
        return () => g.dispose()
      }, [props.sessionId])
      return React.createElement('div', { ref, className: 'diptych-host' })
    }

    function DiptychIcon (props) {
      const size = props?.size ?? 20
      const h = React.createElement
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', className: props?.className, 'aria-hidden': true },
        h('path', { d: 'M8 3c1.8 2.6 3.6 4.4 3.6 7.6A3.9 3.9 0 0 1 4.4 11C4.4 8.4 6.2 6.2 8 3z', fill: '#ff7a3d' }),
        h('path', { d: 'M16.5 9.5l3.6 2.4-.7 6.6h-5.8l-.7-6.6z', fill: '#5cc8ff' }),
        h('path', { d: 'M3 21h18', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']
    function apply (ctx) {
      injectStyles()
      hostCtx = ctx
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        keepMounted: true,
        priority: 'extension',
        title: () => '双联画',
        guide: [{
          id: 'play',
          order: 60,
          title: () => '双联画',
          description: () => '火与冰：和 Agent 一起玩的双人解谜小游戏',
          icon: DiptychIcon
        }]
      }), 'diptych: tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
        inject: (sessionId) => ({ sessionId })
      }, DiptychBody)), 'diptych: game body')
    }

    module.exports.apply = apply
    module.exports.inject = inject
    module.exports.name = 'diptych'
    return module.exports
  }
})
