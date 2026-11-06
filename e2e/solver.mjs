// An automatic solver for diptych levels, on the engine the browser runs.
// It searches over "macro moves": one hero's autopilot walks to a button,
// lever (and pulls it), lift, gate or its exit while the other stands
// still, then the world settles. Each state it reaches is the real
// simulation, so a solution it finds is one the two autopilots can play.
//
// It also answers the design questions the e2e suite checks: can each
// hero reach its exit without the other ever moving, and can every gem be
// reached in some state along the way.
//
// node e2e/solver.mjs [id ...]   prints each level, its solution and checks
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const engine = await import(pathToFileURL(path.join(ROOT, 'plugin', 'lib', 'engine.js')).href)
const { LEVELS, level, createWorld, step, Pilot, moving, reachable, centreCell, textView, snapshot, KINDS, HEROES } = engine

export { engine, LEVELS }

function clone (W) {
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
function settle (C) {
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

// search explores macro moves breadth first. movers limits which heroes
// may move; goal(W) ends it. Gems reachable in any explored state are
// collected along the way.
export function search (id, { movers = KINDS, goal, limit = 4000, gems = false } = {}) {
  const L = level(id)
  const W0 = createWorld(L)
  if (!settle(W0)) throw new Error('开局就站不稳')
  const ts = targets(L)
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
    if (++explored > limit) break
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

export function solveLevel (id) {
  const L = level(id)
  const t0 = performance.now()
  const res = search(id, { goal: (W) => W.status === 'complete', gems: true })
  const out = { id, name: L.name, ok: res.ok, path: res.path, W: res.W, states: res.states, ms: 0 }
  // Every gem: reachable in some explored state (the search stops at the
  // first solution, so keep looking with gems as the goal if needed).
  const all = L.gems.map((g) => g.id)
  let missing = all.filter((g) => !res.gemSeen.has(g))
  if (missing.length) {
    const more = search(id, { goal: () => false, gems: true, limit: 6000 })
    missing = missing.filter((g) => !more.gemSeen.has(g))
  }
  out.missingGems = missing
  // Co-op: can a hero reach its exit while the other never moves?
  out.alone = KINDS.filter((k) => search(id, { movers: [k], goal: (W) => W.heroes[k].atExit, limit: 400 }).ok)
  out.ms = Math.round(performance.now() - t0)
  return out
}

export const describe = (step) => `${HEROES[step.who].zh}${step.use ? '拉' : '去'} ${typeof step.go === 'object' ? `(${step.go.x},${step.go.y})` : step.go}`

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ids = process.argv.slice(2)
  for (const def of LEVELS) {
    if (ids.length && !ids.includes(def.id)) continue
    const L = level(def.id)
    if (ids.length) console.log(textView(L, snapshot(createWorld(L)), 'ember').split('\n').slice(2, 4 + L.h).join('\n'))
    const r = solveLevel(def.id)
    const line = r.ok ? `${r.path.length} 步：${r.path.map(describe).join(' → ')}` : '解不开'
    console.log(`${def.id.padStart(2)} ${def.name}  ${r.ok ? 'OK ' : 'FAIL'} ${line}  [${r.states} 态, ${r.ms} ms]${r.missingGems.length ? '  拿不到宝石 ' + r.missingGems.join(',') : ''}${r.alone.length ? '  能独自到出口：' + r.alone.join(',') : ''}`)
  }
}
