// Solves diptych levels with the plugin's solver (plugin/lib/solver.js),
// which plays the two heroes' autopilots as "macro moves" on the engine.
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
const { LEVELS, level, createWorld, textView, snapshot, KINDS, HEROES } = engine

const lib = await import(pathToFileURL(path.join(ROOT, 'plugin', 'lib', 'solver.js')).href)
const { settle, hint } = lib

export { hint }

export { engine, LEVELS }

// search runs the plugin's solver from the start of level `id`.
export function search (id, opts) {
  const W0 = createWorld(level(id))
  if (!settle(W0)) throw new Error('开局就站不稳')
  return lib.search(W0, opts)
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
