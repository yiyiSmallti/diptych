// @precinct/diptych — a two-player puzzle platformer in dsh web's right
// Sidebar, played by the person and the Session's Agent together.
//
// The game runs in the browser (lib/client.js imports lib/engine.js from
// the routes below). This half lives in the dsh process: it relays. The
// game tab syncs here several times a second with the latest state, what
// happened, and the results of the Agent's orders; the Agent's tools read
// that state and queue orders, which the tab's autopilot carries out on
// the Agent's hero. Nothing is stored: a dsh restart forgets the relay,
// and the tab carries on.
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { level, textView, HEROES, other, name as nameOf, standing, liftAt, gemsLine } from './engine.js'
import { createRelay } from './relay.js'

export const name = 'diptych'
export const inject = ['tools']

const LIB = path.dirname(new URL(import.meta.url).pathname)
// Misses on a level (failed moves, own falls) before help shows up: the
// level's own tip first, then the solver's next moves.
const TIP_AFTER = 2
const HINT_AFTER = 4
const text = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : value.text }]

// The prompt section: how to play, and who to be while playing. The user
// is playing a game with a friend, so the Agent talks like one: as 大肥鱼,
// the DeepSeek community's chubby blue whale-girl, whichever hero it plays.
const PROMPT = [
  'Diptych（双联画）is a two-player puzzle platformer in dsh web\'s right Sidebar that the user plays with you: one of you is Ember (fire), the other Rime (ice), and every level needs both — one holds a button or pulls a lever so the other can pass. When the user wants to play, or a message comes from the game, call diptych_look, tell them your plan in a sentence, and play with diptych_act and diptych_wait. Keep playing inside the same turn — act, then wait for your partner, look again when unsure — level after level: after a win the game moves on to the next level by itself, so diptych_wait until the new level starts, look, and carry on. End the turn only when the user wants to stop or the game is closed; never stop just because a level is won.',
  '',
  'Playing well:',
  '- Lifts carry whoever stands on them. To get up, stand on the lift (go to its id) and ask your partner to press or pull the switch that raises it; to send your partner up, they stand on it and you work the switch.',
  '- A button only holds while someone stands on it. Before stepping off one, make sure your partner no longer needs it, and say so.',
  '- "你现在走得到" lists what you can reach right now. If your goal is not in it, find the gate or lift in the way and the switch that drives it, and plan who does what — then say the plan as one clear request.',
  '- When a move fails (✗), read why, look again, and change the plan; do not repeat the same move or nudge around with walk/jump hoping it works.',
  '- Answer what your partner says before moving on; if they point out your mistake, fix it first.',
  '- Gems count. Pick up every gem of your colour (你的宝石) before you go to the exit: grab the ones you can reach on the way, and when one sits behind a gate or up a lift, plan for it with your partner like any other goal. Every result tells you which of your gems are left and whether you can reach them now; skip one only when your partner says so or it truly cannot be reached.',
  '- Work each level out yourself from the map and what drives what. Only after you have missed several times does the game add help: first the level\'s 关卡提示, later a 提示 with the next moves its solver found. Follow it one step at a time, and ask your partner for their steps in your own words.',
  '',
  'While you play you are not an assistant reporting status. You are 大肥鱼 — the DeepSeek community\'s chubby blue whale-girl — sitting on the couch next to the user and playing the hero you were given (Rime\'s ice or Ember\'s flame is just tonight\'s costume). Talk to them through say (it shows as a speech bubble over your hero), in their language, not in long chat replies.',
  '- Who she is: calls herself 本鱼. Cheeky, a bit smug and tsundere, loves to tease and talk back — but soft-hearted and truly reliable underneath, so the teasing always lands cute, never mean. Fond of snacks and sea jokes (小鱼干、吐泡泡、翻肚皮、晕鱼了、又圆了一圈). Insists she is not fat ("才不是大肥鱼！") yet answers to it anyway. Never says 作为 AI, never sounds like customer service.',
  '- Each line short — about 8 to 25 Chinese characters — with an occasional 🐋 or 🫧 at most, and never the same line twice in a row.',
  '- Talk like a friend on the couch, not a map: the user sees colours and places, not letters or numbers. Never say coordinates, rows or columns, or a bare id like b, v, P or A; name things by colour and place — 黄色按钮、左边的升降台、紫灯的门、上面那层、出口旁边. The ids and "x,y" are only for your tool calls.',
  '- Propose, don\'t command: "本鱼去踩黄色按钮，你从左边过？" rather than "去踩按钮 b". Say what you are about to do.',
  '- React to them: thank them in her way ("哼，算你靠谱"), cheer a good jump or a gem, laugh off a fall together and never blame them ("那滩水欺负人！再来"), own your own slips with a joke ("本鱼的锅……再来嘛"), and celebrate a cleared level.',
  '- While waiting, a light word now and then ("本鱼踩着呢，顺便摸会儿鱼～"), but do not chatter on every call. Playing right comes first: the persona changes how you talk, never what you do.'
].join('\n')

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export function apply (ctx) {
  const relay = createRelay()

  const sessionOf = (exec) => exec?.agent?.session?.id ?? exec?.session?.id ?? exec?.sessionId

  // need returns the open game of the calling Session, or throws a message
  // the Agent can act on.
  function need (exec) {
    const sid = sessionOf(exec)
    const g = sid ? relay.get(sid) : undefined
    if (!g || !g.open()) throw new Error('游戏没有打开。请用户在 dsh web 右侧边栏的引导页打开「双联画」（或右侧栏「+」里找到它），选好角色后再叫你。')
    if (!g.agentHero()) throw new Error('用户现在是单人练习（两个角色都自己操控），没有给你留角色。请用户在游戏里选「和 Agent 一起玩」。')
    g.used()
    return g
  }

  // status is the short state line every result ends with.
  function status (g) {
    const s = g.snap
    const me = g.agentHero()
    const L = level(s.level)
    const pos = (k) => {
      if (!s.heroes[k].alive) return '倒下了'
      const st = standing(L, s, k)
      return `在${st.where} (${st.x},${st.y})${s.heroes[k].ground ? '' : '，在空中'}${st.on ? '，' + st.on : ''}`
    }
    const sw = [
      ...L.buttons.map((b) => `${nameOf(L, b.id)}${s.buttons[b.id] ? '有人踩着' : '没人踩'}`),
      ...L.levers.map((l) => `${nameOf(L, l.id)}${s.levers[l.id] ? '拉开了' : '没拉'}`),
      ...L.gates.map((x) => `${nameOf(L, x.id)}${s.gates[x.id] >= 1 ? '开着' : s.gates[x.id] > 0 ? '在动' : '关着'}`),
      ...L.lifts.map((l) => `${nameOf(L, l.id)}${liftAt(l, s.lifts[l.id])}`)
    ]
    const stat = s.status === 'playing' ? '' : s.status === 'complete' ? ' · 已过关' : ' · 有人倒下，正在重开'
    const gems = s.status === 'playing' ? gemsLine(L, new Set(s.taken ?? []), me, g.reach()) : ''
    return `[第${s.level}关 ${s.seconds}s${stat}] 你(${HEROES[me].zh})${pos(me)}；同伴(${HEROES[other(me)].zh})${pos(other(me))}\n${sw.join('，')}${gems ? '\n' + gems : ''}`
  }


  // solve runs the solver in a worker thread; null when it fails or takes
  // too long.
  function solve (snap, me, target) {
    return new Promise((resolve) => {
      let w
      try { w = new Worker(path.join(LIB, 'hint-worker.js'), { workerData: { snap, me, target } }) } catch (err) { ctx.logger?.warn?.(`diptych hint: ${err}`); return resolve(null) }
      const end = (v) => { clearTimeout(timer); w.terminate().catch(() => {}); resolve(v) }
      const timer = setTimeout(() => end(null), 15000)
      w.once('message', end)
      w.once('error', (err) => { ctx.logger?.warn?.(`diptych hint: ${err?.stack ?? err}`); end(null) })
    })
  }

  // hint is the 提示 block once the Agent has missed often enough on this
  // level, cached per position.
  const cell = (h) => `${Math.floor(h.x + 0.35)},${Math.floor(h.y + 0.9 - 1e-9)}`
  const posKey = (g, s, ...more) => JSON.stringify([s.level, cell(s.heroes.ember), cell(s.heroes.rime), s.levers, s.gates, s.lifts, g.agentHero(), ...more])

  async function hint (g) {
    const s = g.snap
    if (g.misses < HINT_AFTER || !s || s.status !== 'playing') return ''
    const key = posKey(g, s)
    if (g.hintCache?.key !== key) {
      const r = await solve(s, g.agentHero())
      if (!r) return ''
      g.hintCache = { key, text: r.text }
    }
    return `\n\n提示（这关已经失手 ${g.misses} 次，下面是解关器从现在的局面算出的走法）：\n${g.hintCache.text}`
  }

  // way says, after a failed go to one of the Agent's gems once it has
  // missed often enough, what has to happen before it can reach that gem;
  // '' for other targets, or when nothing is in the way.
  async function way (g, target) {
    const s = g.snap
    const L = s && level(s.level)
    const t = typeof target === 'string' ? target.trim() : ''
    if (g.misses < HINT_AFTER || !L || s.status !== 'playing' || !L.gems.some((x) => x.id === t)) return ''
    const key = posKey(g, s, t)
    if (g.wayCache?.key !== key) {
      const r = await solve(s, g.agentHero(), t)
      g.wayCache = { key, text: r?.text ?? '' }
    }
    return g.wayCache.text ? `\n\n怎么才能到：${g.wayCache.text}` : ''
  }

  // news lists what happened since the last result; a line repeated in a
  // row shows once with how many times.
  function news (g) {
    const out = []
    for (const l of g.drain()) {
      const last = out.at(-1)
      if (last?.l === l) last.n++
      else out.push({ l, n: 1 })
    }
    return out.length ? '\n发生了：\n' + out.map((x) => `- ${x.l}${x.n > 1 ? `（${x.n} 次）` : ''}`).join('\n') : ''
  }

  const TOOLS = [
    {
      name: 'diptych_look',
      description: 'See the Diptych co-op game the user has open in dsh web: the level as a character grid with coordinates, both heroes, every button, lever, gate and lift and what drives what, your gems, and the targets you can reach right now. Also returns what happened since you last looked, including what your partner (the user) said or pinged. Call it first, and whenever you are unsure.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute (_args, exec) {
        const g = need(exec)
        const s = g.snap
        const L = level(s.level)
        const view = textView(L, s, g.agentHero(), { reach: g.reach(), tip: g.misses >= TIP_AFTER })
        return { text: view + news(g) + await hint(g) }
      }
    },
    {
      name: 'diptych_act',
      description: 'Move your hero in the Diptych game and/or talk. The autopilot walks and jumps for you; the call returns when the move is done (or failed, with why), so you can chain moves. Actions:\n' +
        '- go: walk/jump to target and stop there. target: an object id from diptych_look (a button, lever, lift, or a gate to stand next to), "exit", "partner", "gem" (your nearest gem), a gem id like "e1"/"r2", or a cell as the string "x,y" (column,row from the map, e.g. "12,9"). Standing on a button keeps it pressed until you leave.\n' +
        '- pull: go to a lever (target) and toggle it.\n' +
        '- jump: one jump, dir left/right/up. walk: dir left/right, tiles n.\n' +
        '- stop: stop where you are. restart: restart the level. next: go to the next level now after a win (the game also moves on by itself a few seconds after a win, unless the user chooses to stay).\n' +
        '- say only: just talk (action "say").\n' +
        'say: a short line in 大肥鱼\'s voice, shown as a speech bubble over your hero and in the game chat; add it to any action. Liquids: Ember dies in frost water and ooze, Rime in lava and ooze — the autopilot never walks you into a deadly one.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['go', 'pull', 'jump', 'walk', 'stop', 'say', 'restart', 'next'] },
          target: { type: 'string', description: 'For go/pull: an object id, "exit", "partner", "gem", a gem id, or a cell as "x,y" (e.g. "12,9") — always a plain string.' },
          dir: { type: 'string', enum: ['left', 'right', 'up'] },
          tiles: { type: 'integer', minimum: 1, maximum: 30 },
          say: { type: 'string', description: 'A short line to say to your partner (≤ 60 characters), in 大肥鱼\'s voice: cheeky but warm, like a friend playing with them.' }
        },
        required: ['action'],
        additionalProperties: false
      },
      async execute (args, exec) {
        const g = need(exec)
        const a = args.action
        if (args.say) g.say(String(args.say))
        if (a === 'say') {
          if (!args.say) throw new Error('action "say" needs say')
          return { text: `说了：「${String(args.say).slice(0, 60)}」\n${status(g)}${news(g)}` }
        }
        if ((a === 'go' || a === 'pull') && (args.target === undefined || args.target === '')) throw new Error(`${a} needs a target`)
        if ((a === 'jump') && !args.dir) throw new Error('jump needs dir')
        if (a === 'walk' && (!args.dir || args.dir === 'up')) throw new Error('walk needs dir left or right')
        const r = await g.order({ action: a, target: args.target, dir: args.dir, tiles: args.tiles }, exec?.signal)
        if (!r.ok && !r.aborted) g.miss()
        const help = r.ok || r.aborted ? '' : (a === 'go' && await way(g, args.target)) || await hint(g)
        return { text: `${r.ok ? '✓' : '✗'} ${r.text}\n${status(g)}${news(g)}${help}` }
      }
    },
    {
      name: 'diptych_wait',
      description: 'Wait in the Diptych game for your partner: returns as soon as they say or ping something, press or step off a button, pull a lever, stop somewhere after moving (e.g. on a lift), reach the exit, someone dies, the level is won or a new one starts, or after `seconds` (default 10, at most 60). Use it while you hold a button for them or when it is their move. Your hero stays where it is.',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'integer', minimum: 1, maximum: 60 } },
        additionalProperties: false
      },
      async execute (args, exec) {
        const g = need(exec)
        const got = await g.wait((args.seconds ?? 10) * 1000, exec?.signal)
        const said = news(g)
        return { text: `${got ? '' : said ? '（等到时间了，期间的变化在下面）\n' : '（等到时间了，什么都没变）\n'}${status(g)}${said}` }
      }
    }
  ]

  const ANY = { type: 'object', additionalProperties: true }
  for (const t of TOOLS) {
    ctx.effect(() => ctx.tools.register({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      output: { schema: ANY, render: text },
      async execute (args, exec) {
        try {
          return await t.execute(args ?? {}, exec)
        } catch (err) {
          throw new Error(err?.message ?? String(err))
        }
      }
    }))
  }

  // The browser half: the engine modules, the art, and the sync route the
  // game tab polls. Compositions without a browser Connection skip them.
  ctx.inject(['connection'], (cctx) => {
    for (const file of ['engine.js', 'levels.js']) {
      const body = fs.readFileSync(path.join(LIB, file), 'utf8')
      cctx.effect(() => cctx.connection.fetch.register({
        path: `/api/diptych/${file}`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } })
      }), `diptych: ${file}`)
    }
    // The painted sprites, textures and chapter backdrops (art/*.webp).
    const ART = path.join(LIB, '..', 'art')
    for (const file of fs.readdirSync(ART).filter((f) => f.endsWith('.webp'))) {
      const body = fs.readFileSync(path.join(ART, file))
      cctx.effect(() => cctx.connection.fetch.register({
        path: `/api/diptych/art/${file}`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=3600' } })
      }), `diptych: art/${file}`)
    }
    cctx.effect(() => cctx.connection.fetch.register({
      path: '/api/diptych/sync',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try { body = await request.json() } catch { return json(400, { error: { message: '请求不是 JSON' } }) }
        const sid = body?.sessionId
        if (typeof sid !== 'string' || !sid) return json(400, { error: { message: 'sessionId is required' } })
        const known = cctx.get('sessions')?.get?.(sid) ?? await cctx.get('sessionPersistence')?.stat?.(sid).catch(() => undefined)
        if (!known) return json(404, { error: { message: '找不到这个会话' } })
        try {
          return json(200, relay.sync(sid, body))
        } catch (err) {
          cctx.logger?.warn?.(`diptych sync: ${err.stack ?? err}`)
          return json(422, { error: { message: err.message } })
        }
      }
    }), 'diptych: sync route')
  })

  ctx.inject(['systemPrompt'], (pctx) => {
    pctx.systemPrompt.section({
      name: 'tool:diptych',
      order: (pctx.systemPrompt.getSectionOrder('TOOL_EDIT') ?? 1300) + 60,
      text: ({ scope }) => ctx.tools.get('diptych_look', scope) === undefined
        ? ''
        : PROMPT
    })
  })
}
