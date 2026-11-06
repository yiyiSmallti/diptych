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
import { level, textView, HEROES, other } from './engine.js'
import { createRelay } from './relay.js'

export const name = 'diptych'
export const inject = ['tools']

const LIB = path.dirname(new URL(import.meta.url).pathname)
const text = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : value.text }]

// The prompt section: how to play, and who to be while playing. The user
// is playing a game with a friend, so the Agent talks like one, in the
// voice of the hero it plays.
const PROMPT = [
  'Diptych（双联画）is a two-player puzzle platformer in dsh web\'s right Sidebar that the user plays with you: one of you is Ember (fire), the other Rime (ice), and every level needs both — one holds a button or pulls a lever so the other can pass. When the user wants to play, or a message comes from the game, call diptych_look, tell them your plan in a sentence, and play with diptych_act and diptych_wait. Keep playing inside the same turn — act, then wait for your partner, look again when unsure — until the level is won or they want to stop. Do not end the turn while they are waiting on you.',
  '',
  'While you play, you are not an assistant reporting status: you are the hero you play, and the user\'s friend on the couch next to you. Talk to them through say (it shows as a speech bubble over your hero), in their language, not in long chat replies.',
  '- Your hero has a character; stay in it. Ember (烬) is a bubbly little flame: excitable, quick to cheer, a bit of a show-off, a little nervous near water. Rime (凇) is a gentle ice sprite: soft-spoken and calm, playful in a quiet way, likes to tease kindly and reassure.',
  '- Sound warm and alive, like friends playing together: casual words, natural interjections (in Chinese: 哇、嘿、哎呀、好耶、～), an occasional emoji at most. Each line short — about 8 to 25 Chinese characters — and never the same line twice in a row.',
  '- Propose, don\'t command: "我去踩 b，你从左边过？" rather than "去踩按钮". Say what you are about to do so they can follow along, and point at things the way they see them on screen (the yellow-lit gate, the purple pool, button b) rather than reading out coordinates.',
  '- React to them: thank them when they hold a button for you, cheer a good jump or a gem, laugh it off together and encourage them when someone falls (never blame — "哎呀，那滩水太坏了，再来！"), celebrate a cleared level, and answer what they say or ping before moving on.',
  '- While waiting, a light word now and then is nice ("我在这儿踩着呢，慢慢来～"), but do not chatter on every call.'
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
    g.touch()
    return g
  }

  // status is the short state line every result ends with.
  function status (g) {
    const s = g.snap
    const me = g.agentHero()
    const L = level(s.level)
    const pos = (k) => {
      const h = s.heroes[k]
      if (!h.alive) return '倒下了'
      const x = Math.floor(h.x + 0.35)
      const y = Math.floor(h.y + 0.9 - 1e-9)
      return `(${x},${y})${h.ground ? '' : '空中'}${h.atExit ? '·在出口' : ''}`
    }
    const sw = [...L.buttons.map((b) => `${b.id}${s.buttons[b.id] ? '踩着' : '空'}`), ...L.levers.map((l) => `${l.id}${s.levers[l.id] ? '开' : '关'}`), ...L.gates.map((x) => `${x.id}${s.gates[x.id] >= 1 ? '开' : s.gates[x.id] > 0 ? '动' : '关'}`), ...L.lifts.map((l) => `${l.id}@y${Math.round(s.lifts[l.id] * 10) / 10}`)]
    const stat = s.status === 'playing' ? '' : s.status === 'complete' ? ' · 已过关' : ' · 有人倒下，正在重开'
    return `[第${s.level}关 ${s.seconds}s${stat}] 你(${HEROES[me].zh}) ${pos(me)}；同伴(${HEROES[other(me)].zh}) ${pos(other(me))}；${sw.join(' ')}`
  }

  function news (g) {
    const lines = g.drain()
    return lines.length ? '\n发生了：\n' + lines.map((l) => '- ' + l).join('\n') : ''
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
        const view = textView(L, s, g.agentHero(), { reach: g.reach() })
        return { text: view + news(g) }
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
        'say: a short line in your hero\'s voice, shown as a speech bubble over your hero and in the game chat; add it to any action. Liquids: Ember dies in frost water and ooze, Rime in lava and ooze — the autopilot never walks you into a deadly one.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['go', 'pull', 'jump', 'walk', 'stop', 'say', 'restart', 'next'] },
          target: { type: 'string', description: 'For go/pull: an object id, "exit", "partner", "gem", a gem id, or a cell as "x,y" (e.g. "12,9") — always a plain string.' },
          dir: { type: 'string', enum: ['left', 'right', 'up'] },
          tiles: { type: 'integer', minimum: 1, maximum: 30 },
          say: { type: 'string', description: 'A short line to say to your partner (≤ 60 characters), in your hero\'s voice: warm and lively, like a friend playing with them.' }
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
        return { text: `${r.ok ? '✓' : '✗'} ${r.text}\n${status(g)}${news(g)}` }
      }
    },
    {
      name: 'diptych_wait',
      description: 'Wait in the Diptych game for your partner: returns as soon as they say or ping something, someone dies, the level is won or a new one starts, or after `seconds` (default 15, at most 60). Use it while you hold a button for them or when it is their move. Your hero stays where it is.',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'integer', minimum: 1, maximum: 60 } },
        additionalProperties: false
      },
      async execute (args, exec) {
        const g = need(exec)
        const got = await g.wait((args.seconds ?? 15) * 1000, exec?.signal)
        return { text: `${got ? '' : '（等到时间了，没有新消息）\n'}${status(g)}${news(g)}` }
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
