// The level solver, on the same engine the browser runs. It searches over
// "macro moves": one hero's autopilot walks to a button, lever (and pulls
// it), lift, gate or its exit while the other stands still, then the
// world settles. Each state it reaches is the real simulation, so a
// solution it finds is one the two autopilots can play.
//
// The host uses it for hints when the Agent keeps failing (lib/index.js);
// e2e/solver.mjs uses it to prove every level can be cleared.
import { level, createWorld, step, Pilot, moving, reachable, centreCell, KINDS, HEROES, name, where } from './engine.js'

export function clone (W) {
  return {
    ...W,
    heroes: { ember: { ...W.heroes.ember }, rime: { ...W.heroes.rime } },
    taken: new Set(W.taken),
    levers: { ...W.levers },
    buttons: { ...W.buttons },
    gates: { ...W.gates },
    lifts: { ...W.lifts },
    events: []
  }
}

function key (W) {
  let k = ''
  for (const h of KINDS) {
    const c = centreCell(W.heroes[h])
    k += `${c.x},${c.y};`
  }
  for (const l of W.L.levers) k += W.levers[l.id] ? 1 : 0
  k += '|'
  for (const g of W.L.gates) k += W.gates[g.id] >= 1 ? 'o' : W.gates[g.id] <= 0 ? 'c' : 'm'
  for (const l of W.L.lifts) k += '|' + W.lifts[l.id].toFixed(2)
  return k
}

function targets (L) {
  const out = []
  for (const b of L.buttons) out.push({ go: b.id })
  for (const l of L.levers) out.push({ go: l.id, use: true })
  for (const l of L.lifts) out.push({ go: l.id })
  for (const g of L.gates) out.push({ go: g.id })
  out.push({ go: 'exit' })
  // Somewhere to step aside to: the two starts.
  for (const k of KINDS) out.push({ go: { x: L.starts[k].x, y: L.starts[k].y } })
  return out
}

// settle runs idle frames until nothing moves and both heroes stand.
export function settle (C) {
  for (let i = 0; i < 900; i++) {
    if (!moving(C) && C.heroes.ember.ground && C.heroes.rime.ground) return true
    step(C, {})
    if (C.status === 'dead') return false
  }
  return false
}

// macro plays one hero's move on a copy of W; null when it fails or kills.
function macro (W, who, t) {
  const C = clone(W)
  const p = new Pilot(who)
  let res = null
  p.go(C, t.go, { use: t.use }, (r) => { res = r })
  for (let i = 0; i < 60 * 40 && !res; i++) {
    step(C, { [who]: p.tick(C) })
    if (C.status === 'dead') return null
  }
  if (!res?.ok) return null
  if (!settle(C)) return null
  if (C.heroes.ember.atExit && C.heroes.rime.atExit) {
    for (let i = 0; i < 40 && C.status === 'playing'; i++) step(C, {})
  }
  return C
}

// search explores macro moves breadth first from the settled world W0.
// movers limits which heroes may move; goal(W) ends it; it gives up after
// `limit` states or at `deadline` (a performance.now() time). Gems
// reachable in any explored state are collected along the way.
export function search (W0, { movers = KINDS, goal, limit = 4000, gems = false, deadline = Infinity } = {}) {
  const ts = targets(W0.L)
  const seen = new Map([[key(W0), null]])
  const queue = [{ W: W0, path: [] }]
  const gemSeen = new Set()
  let explored = 0
  const see = (W) => {
    if (!gems) return
    for (const g of W.taken) gemSeen.add(g)
    for (const k of KINDS) for (const r of reachable(W, k) ?? []) if (/^[er]\d+$/.test(r)) gemSeen.add(r)
  }
  see(W0)
  while (queue.length) {
    const { W, path } = queue.shift()
    if (++explored > limit || performance.now() > deadline) break
    for (const who of movers) {
      for (const t of ts) {
        const C = macro(W, who, t)
        if (!C) continue
        const k = key(C)
        if (seen.has(k) && C.status !== 'complete') continue
        seen.set(k, true)
        const np = [...path, { who, ...t }]
        if (goal(C)) return { ok: true, path: np, W: C, explored, states: seen.size, gemSeen }
        see(C)
        queue.push({ W: C, path: np })
      }
    }
  }
  return { ok: false, explored, states: seen.size, gemSeen }
}

// worldFrom rebuilds a world from a game tab's snapshot, then lets it
// settle (a hero caught mid-jump lands first).
export function worldFrom (s) {
  const L = level(s.level)
  const W = createWorld(L)
  W.tick = s.tick ?? 0
  for (const k of KINDS) {
    const h = s.heroes?.[k]
    if (!h) continue
    Object.assign(W.heroes[k], { x: +h.x, y: +h.y, vx: 0, vy: 0, ground: null, alive: h.alive !== false, atExit: !!h.atExit })
  }
  W.taken = new Set((s.taken ?? []).filter((g) => L.gems.some((x) => x.id === g)))
  for (const l of L.levers) if (typeof s.levers?.[l.id] === 'boolean') W.levers[l.id] = s.levers[l.id]
  for (const g of L.gates) if (Number.isFinite(s.gates?.[g.id])) W.gates[g.id] = s.gates[g.id]
  for (const l of L.lifts) if (Number.isFinite(s.lifts?.[l.id])) W.lifts[l.id] = s.lifts[l.id]
  return settle(W) ? W : null
}

// describeStep says one macro move to the Agent playing `me`.
export function describeStep (L, st, me) {
  const who = st.who === me ? '你' : `请同伴（${HEROES[st.who].zh}）`
  const t = st.go
  if (typeof t === 'object') return `${who}退到${where(L, t.x, t.y)} (${t.x},${t.y}) 让开`
  if (t === 'exit') return `${who}去出口`
  const o = L.byId.get(t)
  if (st.use) return `${who}去拉${name(L, t)}`
  if (o?.type === 'button') return `${who}去踩住${name(L, t)}`
  if (o?.type === 'lift') return `${who}站上${name(L, t)}`
  if (o?.type === 'gate') return `${who}走到${name(L, t)}旁边`
  return `${who}去 ${t}`
}

// hint finds how to clear the level from the snapshot and says the next
// few moves; null when the game is not in play.
export function hint (s, me, { ms = 1500, steps = 3 } = {}) {
  if (!s || s.status !== 'playing') return null
  const W = worldFrom(s)
  if (!W) return null
  const r = search(W, { goal: (C) => C.status === 'complete', deadline: performance.now() + ms })
  if (!r.ok) return { ok: false, text: '解关器从现在的局面没找到走法；如果卡死了，可以跟同伴商量用 restart 重开这一关。' }
  const next = r.path.slice(0, steps).map((st, i) => `${i + 1}. ${describeStep(W.L, st, me)}`)
  const more = r.path.length > steps ? `（之后还有 ${r.path.length - steps} 步，做完再 look 会给新的提示）` : ''
  return { ok: true, path: r.path, text: `${next.join('；')}${more}。每一步做完就原地站住，等下一步的人做完。` }
}

// route finds what has to happen before `me` can reach `target` (an
// object, a gem or "exit"): the moves until it shows among the places
// `me` can reach. null when it already can, or the game is not in play.
export function route (s, me, target, { ms = 2500, steps = 4 } = {}) {
  if (!s || s.status !== 'playing') return null
  const W = worldFrom(s)
  if (!W) return null
  const L = W.L
  const gem = L.gems.find((g) => g.id === target)
  const label = target === 'exit' ? '出口' : gem ? `宝石 ${target}` : name(L, target)
  const can = (C) => (reachable(C, me) ?? []).includes(target)
  if (can(W)) return null
  const r = search(W, { goal: can, deadline: performance.now() + ms })
  if (!r.ok) return { ok: false, text: `解关器从现在的局面没找到办法让你走到${label}。${gem ? '宝石可选，不拿也能过关。' : '如果卡死了，可以跟同伴商量用 restart 重开这一关。'}` }
  const next = r.path.slice(0, steps).map((st, i) => `${i + 1}. ${describeStep(L, st, me)}`)
  const more = r.path.length > steps ? `（之后还有 ${r.path.length - steps} 步）` : ''
  return { ok: true, text: `要走到${label}，得先：${next.join('；')}${more}。做完这些你就走得到了。` }
}
