// Diptych game engine: level parsing, the fixed-step physics, the
// autopilot that walks and jumps a hero to a target, and the text view the
// Agent plays from.
//
// A plain ES module with no imports besides ./levels.js and nothing
// platform-specific: dsh's host imports it for the Agent's view, the
// browser imports it (the host serves both files) to run the game, and the
// e2e solver runs it in Node. The simulation is deterministic: the same
// inputs from the same state give the same frames, which is what lets the
// autopilot plan a jump by simulating it and then play it back.
import { LEVELS, CHAPTERS } from './levels.js'

export { LEVELS, CHAPTERS }

export const TICK = 1 / 60
// Units are tiles and seconds. Jump height ≈ 2.6 tiles, so a hero climbs
// a 2-tile step; a running jump clears a 3-tile gap.
export const P = { speed: 6, gravity: 40, jump: 14.5, maxFall: 20, w: 0.7, h: 0.9, coyote: 6, buffer: 8, gate: 2.5, gateShut: 8, lift: 3 }
const EPS = 1e-9

export const HEROES = {
  ember: { id: 'ember', zh: '烬', en: 'Ember', safe: 'lava', color: '#ff7a3d' },
  rime: { id: 'rime', zh: '凇', en: 'Rime', safe: 'frost', color: '#5cc8ff' }
}
export const KINDS = ['ember', 'rime']
export const other = (k) => (k === 'ember' ? 'rime' : 'ember')

const LIQUIDS = { '^': 'lava', '~': 'frost', '%': 'ooze' }
export const LIQUID_ZH = { lava: '熔岩', frost: '寒潭', ooze: '毒沼' }
const deadly = (kind, liquid) => !!liquid && liquid !== HEROES[kind].safe

// ------------------------------------------------------------ levels

// parseLevel turns a level definition into its static layout: the map
// rows use # wall, . air, = a ledge (stood on from above, jumped through
// from below), ^ lava, ~ frost water, % ooze, * Ember's gem, o Rime's
// gem, E and R the exits, 1 and 2 the starts; any other
// character is an object named in def.objects (a button, lever, gate or
// lift) and is its id.
export function parseLevel (def) {
  const rows = def.map
  const h = rows.length
  const w = Math.max(...rows.map((r) => r.length))
  const L = {
    id: def.id, name: def.name, en: def.en, tip: def.tip, w, h,
    solid: new Uint8Array(w * h), ledge: new Uint8Array(w * h), liquid: new Array(w * h).fill(null),
    gems: [], exits: {}, starts: {}, buttons: [], levers: [], gates: [], lifts: [], byId: new Map()
  }
  let n = { ember: 0, rime: 0 }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x] ?? '#'
      const i = y * w + x
      if (ch === '#') L.solid[i] = 1
      else if (ch === '=') L.ledge[i] = 1
      else if (LIQUIDS[ch]) L.liquid[i] = LIQUIDS[ch]
      else if (ch === '*' || ch === 'o') {
        const kind = ch === '*' ? 'ember' : 'rime'
        L.gems.push({ id: `${kind[0]}${++n[kind]}`, kind, x, y })
      } else if (ch === 'E') L.exits.ember = { x, y }
      else if (ch === 'R') L.exits.rime = { x, y }
      else if (ch === '1') L.starts.ember = { x, y }
      else if (ch === '2') L.starts.rime = { x, y }
      else if (ch !== '.' && ch !== ' ') {
        const o = def.objects?.[ch]
        if (!o) throw new Error(`level ${def.id}: unknown map character ${JSON.stringify(ch)} at ${x},${y}`)
        const obj = { ...o, id: ch, x, y, by: [...(o.by ?? [])] }
        if (o.type === 'button') L.buttons.push(obj)
        else if (o.type === 'lever') L.levers.push(obj)
        else if (o.type === 'gate') { obj.w = o.w ?? 1; obj.h = o.h ?? 3; L.gates.push(obj) }
        else if (o.type === 'lift') { obj.w = o.w ?? 3; obj.dy = o.dy ?? -4; L.lifts.push(obj) }
        else throw new Error(`level ${def.id}: object ${ch} has unknown type ${o.type}`)
        L.byId.set(ch, obj)
      }
    }
  }
  for (const k of KINDS) {
    if (!L.starts[k] || !L.exits[k]) throw new Error(`level ${def.id}: ${k} needs a start and an exit`)
  }
  // A bridge (a flat gate) laid across a pool: its letter took the place
  // of a pool cell, which is still pool when the bridge is not there.
  for (const g of L.gates) {
    const i = g.y * w + g.x
    if (g.h === 1 && g.w > 1 && !L.liquid[i] && L.liquid[i + 1]) L.liquid[i] = L.liquid[i + 1]
  }
  for (const o of [...L.gates, ...L.lifts]) {
    for (const b of o.by) {
      const src = L.byId.get(b)
      if (!src || (src.type !== 'button' && src.type !== 'lever')) throw new Error(`level ${def.id}: ${o.id} is driven by ${b}, which is not a button or lever`)
    }
  }
  return L
}

const parsed = new Map()
export function level (id) {
  if (!parsed.has(id)) {
    const def = LEVELS.find((l) => l.id === id)
    if (!def) return undefined
    parsed.set(id, parseLevel(def))
  }
  return parsed.get(id)
}

const solidTile = (L, x, y) => x < 0 || y < 0 || x >= L.w || y >= L.h || L.solid[y * L.w + x] === 1
const ledgeTile = (L, x, y) => x >= 0 && y >= 0 && x < L.w && y < L.h && L.ledge[y * L.w + x] === 1
const liquidAt = (L, x, y) => (x < 0 || y < 0 || x >= L.w || y >= L.h ? null : L.liquid[y * L.w + x])

// ------------------------------------------------------------ world

function heroAt (kind, cell) {
  return { kind, x: cell.x + 0.5 - P.w / 2, y: cell.y + 1 - P.h, vx: 0, vy: 0, ground: 'tile', coyote: 0, buffer: 0, jumpHeld: false, facing: kind === 'ember' ? 1 : -1, alive: true, atExit: false }
}

export function createWorld (L) {
  const W = {
    L, tick: 0, status: 'playing', statusTick: 0, cause: null,
    heroes: { ember: heroAt('ember', L.starts.ember), rime: heroAt('rime', L.starts.rime) },
    taken: new Set(), levers: {}, buttons: {}, gates: {}, lifts: {}, events: []
  }
  for (const l of L.levers) W.levers[l.id] = !!l.on
  for (const b of L.buttons) W.buttons[b.id] = false
  for (const g of L.gates) W.gates[g.id] = active(W, g) !== !!g.invert ? 1 : 0
  for (const l of L.lifts) W.lifts[l.id] = liftWant(W, l)
  return W
}

// active: a gate or lift is driven when any of its buttons or levers is
// on, or, with all: true, when every one of them is.
function active (W, o) {
  const on = (id) => W.levers[id] === true || W.buttons[id] === true
  return o.all ? o.by.every(on) : o.by.some(on)
}

// liftWant: where a lift is headed. A lift rises by dy while its switches
// are on (with invert: true, while they are off) and sinks back otherwise.
const liftWant = (W, l) => (active(W, l) !== !!l.invert ? l.y + l.dy : l.y)

const rectOf = (hero) => ({ x: hero.x, y: hero.y, w: P.w, h: P.h })
const overlap = (a, b) => a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS

function gateRect (W, g) {
  const f = W.gates[g.id]
  return { x: g.x, y: g.y, w: g.w, h: g.h * (1 - f) }
}
const liftRect = (W, l) => ({ x: l.x, y: W.lifts[l.id], w: l.w, h: 0.5 })

// solids lists everything solid that r touches: tiles (the map's edge
// counts), closed parts of gates, and lifts.
function solids (W, r, skipLift) {
  const L = W.L
  const out = []
  const x0 = Math.floor(r.x + EPS)
  const x1 = Math.floor(r.x + r.w - EPS)
  const y0 = Math.floor(r.y + EPS)
  const y1 = Math.floor(r.y + r.h - EPS)
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (solidTile(L, tx, ty)) out.push({ x: tx, y: ty, w: 1, h: 1 })
  for (const g of L.gates) {
    const b = gateRect(W, g)
    if (b.h > 0.001 && overlap(r, b)) out.push(b)
  }
  for (const l of L.lifts) {
    if (l.id === skipLift) continue
    const b = liftRect(W, l)
    if (overlap(r, b)) out.push({ ...b, lift: l.id })
  }
  return out
}

function moveHero (W, hero, dx, dy) {
  if (dx) {
    hero.x += dx
    const hit = solids(W, rectOf(hero))
    if (hit.length) {
      hero.x = dx > 0 ? Math.min(...hit.map((b) => b.x)) - P.w : Math.max(...hit.map((b) => b.x + b.w))
      hero.vx = 0
    }
  }
  hero.ground = null
  if (dy) {
    const feet = hero.y + P.h
    hero.y += dy
    const hit = solids(W, rectOf(hero))
    // Ledges stop a fall that starts above them.
    if (dy > 0) {
      const r = rectOf(hero)
      for (let ty = Math.floor(feet - EPS); ty <= Math.floor(r.y + r.h - EPS); ty++) {
        if (ty < feet - EPS) continue
        for (let tx = Math.floor(r.x + EPS); tx <= Math.floor(r.x + r.w - EPS); tx++) if (ledgeTile(W.L, tx, ty)) hit.push({ x: tx, y: ty, w: 1, h: 1 })
      }
    }
    if (hit.length) {
      if (dy > 0) {
        const top = Math.min(...hit.map((b) => b.y))
        hero.y = top - P.h
        hero.ground = hit.find((b) => b.y === top && b.lift)?.lift ?? 'tile'
      } else {
        hero.y = Math.max(...hit.map((b) => b.y + b.h))
      }
      hero.vy = 0
    }
  }
}

// stepHero applies one frame of input: x in [-1, 1] (the autopilot uses
// fractions to stop exactly), jump held, use pressed this frame.
function stepHero (W, hero, inp) {
  const ix = Math.max(-1, Math.min(1, inp?.x ?? 0))
  hero.vx = ix * P.speed
  if (ix) hero.facing = Math.sign(ix)
  const jump = !!inp?.jump
  if (jump && !hero.jumpHeld) hero.buffer = P.buffer
  hero.jumpHeld = jump
  if (hero.ground) hero.coyote = P.coyote
  else if (hero.coyote > 0) hero.coyote--
  let jumped = false
  if (hero.buffer > 0 && hero.coyote > 0) {
    hero.vy = -P.jump
    hero.buffer = 0
    hero.coyote = 0
    jumped = true
  } else if (hero.buffer > 0) hero.buffer--
  hero.vy = Math.min(hero.vy + P.gravity * TICK, P.maxFall)
  moveHero(W, hero, hero.vx * TICK, hero.vy * TICK)
  return jumped
}

// hazard is the liquid that kills this hero where it stands, if any: the
// lower 40% of a pool cell, a little in from its sides, is the liquid.
function hazard (W, hero) {
  const r = rectOf(hero)
  for (let ty = Math.floor(r.y + EPS); ty <= Math.floor(r.y + r.h - EPS); ty++) {
    for (let tx = Math.floor(r.x + EPS); tx <= Math.floor(r.x + r.w - EPS); tx++) {
      const liq = liquidAt(W.L, tx, ty)
      if (deadly(hero.kind, liq) && overlap(r, { x: tx + 0.1, y: ty + 0.6, w: 0.8, h: 0.4 })) return liq
    }
  }
  return null
}

const onCell = (hero, o) => overlap(rectOf(hero), { x: o.x + 0.1, y: o.y + 0.1, w: 0.8, h: 0.9 })
const pressing = (hero, b) => overlap(rectOf(hero), { x: b.x + 0.05, y: b.y + 0.7, w: 0.9, h: 0.3 })
export const centreCell = (hero) => ({ x: Math.floor(hero.x + P.w / 2), y: Math.floor(hero.y + P.h - EPS) })

// step advances the world one frame. inputs: { ember: {x, jump, use},
// rime: {...} }. Things that happen are pushed onto W.events.
export function step (W, inputs) {
  const L = W.L
  W.tick++
  if (W.status !== 'playing') return
  const hs = KINDS.map((k) => W.heroes[k])
  // Levers: use while standing at one toggles it.
  for (const k of KINDS) {
    const hero = W.heroes[k]
    if (!inputs?.[k]?.use || !hero.alive) continue
    for (const l of L.levers) {
      if (onCell(hero, l)) {
        W.levers[l.id] = !W.levers[l.id]
        W.events.push({ type: 'lever', id: l.id, on: W.levers[l.id], by: k })
      }
    }
  }
  for (const b of L.buttons) {
    const on = hs.some((h) => h.alive && pressing(h, b))
    if (on !== W.buttons[b.id]) {
      W.buttons[b.id] = on
      W.events.push({ type: 'button', id: b.id, on, by: on ? hs.find((h) => h.alive && pressing(h, b)).kind : null })
    }
  }
  for (const g of L.gates) {
    const want = active(W, g) !== !!g.invert ? 1 : 0
    const f = W.gates[g.id]
    if (f === want) continue
    // Gates open slowly and slam shut, so nobody slips through behind a
    // partner who has just stepped off the button.
    const nf = want > f ? Math.min(1, f + P.gate * TICK) : Math.max(0, f - P.gateShut * TICK)
    if (nf < f) {
      // Closing: never down onto a hero.
      const r = { x: g.x, y: g.y, w: g.w, h: g.h * (1 - nf) }
      if (hs.some((h) => h.alive && overlap(rectOf(h), r))) continue
    }
    W.gates[g.id] = nf
    if (nf === want) W.events.push({ type: 'gate', id: g.id, open: want === 1 })
  }
  for (const l of L.lifts) {
    const want = liftWant(W, l)
    const y = W.lifts[l.id]
    if (y === want) continue
    const d = Math.sign(want - y) * Math.min(P.lift * TICK, Math.abs(want - y))
    const riders = hs.filter((h) => h.alive && h.ground === l.id)
    const next = { x: l.x, y: y + d, w: l.w, h: 0.5 }
    let stall = false
    if (d < 0) {
      for (const r of riders) if (solids(W, { ...rectOf(r), y: r.y + d }, l.id).length) stall = true
    } else {
      for (const h of hs) if (h.alive && !riders.includes(h) && overlap(rectOf(h), next)) stall = true
    }
    if (stall) continue
    W.lifts[l.id] = y + d
    for (const r of riders) r.y += d
    if (d < 0) for (const h of hs) if (h.alive && !riders.includes(h) && overlap(rectOf(h), next)) { h.y = next.y - P.h; h.vy = 0; h.ground = l.id }
    if (W.lifts[l.id] === want) W.events.push({ type: 'lift', id: l.id, up: want < l.y })
  }
  for (const k of KINDS) {
    const hero = W.heroes[k]
    if (!hero.alive) continue
    stepHero(W, hero, inputs?.[k])
    const liq = hazard(W, hero)
    if (liq) {
      hero.alive = false
      W.status = 'dead'
      W.statusTick = W.tick
      W.cause = { who: k, liquid: liq }
      W.events.push({ type: 'died', who: k, liquid: liq })
      return
    }
    if (hero.y > L.h + 2) {
      hero.alive = false
      W.status = 'dead'
      W.statusTick = W.tick
      W.cause = { who: k, liquid: null }
      W.events.push({ type: 'died', who: k, liquid: null })
      return
    }
    for (const g of L.gems) {
      if (g.kind !== k || W.taken.has(g.id)) continue
      if (overlap(rectOf(hero), { x: g.x + 0.15, y: g.y + 0.15, w: 0.7, h: 0.7 })) {
        W.taken.add(g.id)
        W.events.push({ type: 'gem', id: g.id, by: k })
      }
    }
    const ex = L.exits[k]
    const c = centreCell(hero)
    const at = !!hero.ground && c.x === ex.x && c.y === ex.y
    if (at !== hero.atExit) {
      hero.atExit = at
      W.events.push({ type: 'exit', who: k, at })
    }
  }
  if (hs.every((h) => h.atExit)) {
    W.exitTicks = (W.exitTicks ?? 0) + 1
    if (W.exitTicks >= 30) {
      W.status = 'complete'
      W.statusTick = W.tick
      W.events.push({ type: 'complete', gems: W.taken.size, of: L.gems.length, seconds: Math.round(W.tick * TICK) })
    }
  } else W.exitTicks = 0
}

// ------------------------------------------------------------ autopilot

// Planning sees the world as it is now, frozen: gates count as walls
// unless fully open, lifts stay where they are. A hero stands on a node:
// an empty cell with something solid right under it that is safe for it.
function cellSolid (W, x, y) {
  if (solidTile(W.L, x, y)) return true
  for (const g of W.L.gates) if (W.gates[g.id] < 1 && x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.h) return true
  for (const l of W.L.lifts) {
    const ly = W.lifts[l.id]
    if (x >= l.x && x < l.x + l.w && Math.abs(ly - y) < 1e-6) return true
  }
  return false
}

function standable (W, kind, x, y) {
  return !cellSolid(W, x, y) && (cellSolid(W, x, y + 1) || ledgeTile(W.L, x, y + 1)) && !deadly(kind, liquidAt(W.L, x, y))
}

function stateKey (W) {
  let k = ''
  for (const g of W.L.gates) k += W.gates[g.id] >= 1 ? 'o' : 'c'
  for (const l of W.L.lifts) k += W.lifts[l.id].toFixed(3) + ','
  return k
}

// A planning world: the real one's layout and object states, no events.
function frozen (W) {
  return { L: W.L, gates: W.gates, lifts: W.lifts }
}

// Programs: a jump (with a direction held for some frames, then let go)
// or walking off an edge (the same way). Each is simulated from the
// centre of a node, standing still.
const HOLDS = [0, 3, 6, 9, 12, 16, 20, 25, 30, 999]
function programs (W, kind, x, y) {
  const out = []
  out.push({ jump: true, dir: 0, hold: 0 })
  for (const dir of [-1, 1]) {
    for (const hold of HOLDS) if (hold) out.push({ jump: true, dir, hold })
    if (!cellSolid(W, x + dir, y) && !standable(W, kind, x + dir, y)) {
      for (const hold of [8, 10, 12, 15, 18, 22, 999]) out.push({ jump: false, dir, hold })
    }
  }
  return out
}

const progInput = (prog, f) => ({ x: f < prog.hold ? prog.dir : 0, jump: prog.jump && f < 18 })

// simulate runs a program from a node's centre on a frozen world and says
// where the hero lands, the cells it touched, and the frames it took; null
// when it dies or never lands.
function simulate (F, kind, x, y, prog) {
  const hero = heroAt(kind, { x, y })
  const touched = new Set()
  for (let f = 0; f < 180; f++) {
    stepHero(F, hero, progInput(prog, f))
    if (hazard(F, hero)) return null
    if (hero.y > F.L.h + 1) return null
    const r = rectOf(hero)
    for (let ty = Math.floor(r.y + EPS); ty <= Math.floor(r.y + r.h - EPS); ty++) {
      for (let tx = Math.floor(r.x + EPS); tx <= Math.floor(r.x + r.w - EPS); tx++) touched.add(tx + ',' + ty)
    }
    if (f > 0 && hero.ground) {
      const at = landing(F, kind, hero)
      if (!at) return null
      return { x: at.x, y: at.y, frames: f + 1, touched, endX: hero.x }
    }
  }
  return null
}

// landing is the node a grounded hero is on: the cell under its centre,
// or the neighbour its feet rest on when the centre hangs over an edge.
function landing (F, kind, hero) {
  const c = centreCell(hero)
  if (standable(F, kind, c.x, c.y)) return c
  for (const dx of [-1, 1]) {
    const x = c.x + dx
    const cellL = x
    if (hero.x < cellL + 1 - EPS && hero.x + P.w > cellL + EPS && standable(F, kind, x, c.y)) return { x, y: c.y }
  }
  return null
}

const graphs = new WeakMap()
function graphFor (W, kind) {
  let byLevel = graphs.get(W.L)
  if (!byLevel) { byLevel = new Map(); graphs.set(W.L, byLevel) }
  const key = kind + '|' + stateKey(W)
  let g = byLevel.get(key)
  if (!g) {
    if (byLevel.size > 64) byLevel.clear()
    g = { edges: new Map(), F: { L: W.L, gates: { ...W.gates }, lifts: { ...W.lifts } } }
    byLevel.set(key, g)
  }
  return g
}

function edgesOf (g, kind, x, y) {
  const id = x + ',' + y
  let out = g.edges.get(id)
  if (out) return out
  const F = g.F
  out = []
  for (const dx of [-1, 1]) {
    if (standable(F, kind, x + dx, y)) out.push({ to: { x: x + dx, y }, cost: 1, walk: true, touched: new Set([(x + dx) + ',' + y]) })
  }
  const seen = new Set()
  for (const prog of programs(F, kind, x, y)) {
    const r = simulate(F, kind, x, y, prog)
    if (!r || (r.x === x && r.y === y && !prog.jump)) continue
    const k = `${r.x},${r.y}`
    // Keep the cheapest program per landing, but also every program that
    // touches something new (a gem in the air, a button on the way).
    const sig = k + '|' + [...r.touched].sort().join(';')
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push({ to: { x: r.x, y: r.y }, cost: 2 + r.frames / 12, prog, touched: r.touched })
  }
  g.edges.set(id, out)
  return out
}

// startNode is where a grounded hero is, for planning.
function startNode (W, kind) {
  const hero = W.heroes[kind]
  if (!hero.alive || !hero.ground) return null
  return landing(frozen(W), kind, hero)
}

// search runs Dijkstra from the hero's node. goal(cell) says whether a
// node or a touched cell ends the search. With no goal it returns
// everything reachable.
function search (W, kind, goal, touchGoal) {
  const start = startNode(W, kind)
  if (!start) return { start: null }
  const g = graphFor(W, kind)
  const dist = new Map([[start.x + ',' + start.y, 0]])
  const prev = new Map()
  const open = [{ x: start.x, y: start.y, d: 0 }]
  const reached = new Set()
  const touchedAll = new Set()
  let found = null
  while (open.length) {
    let bi = 0
    for (let i = 1; i < open.length; i++) if (open[i].d < open[bi].d) bi = i
    const cur = open.splice(bi, 1)[0]
    const id = cur.x + ',' + cur.y
    if (reached.has(id)) continue
    reached.add(id)
    touchedAll.add(id)
    if (goal && goal(cur.x, cur.y)) { found = { node: cur }; break }
    for (const e of edgesOf(g, kind, cur.x, cur.y)) {
      for (const t of e.touched) touchedAll.add(t)
      if (touchGoal && !e.walk) {
        for (const t of e.touched) {
          const [tx, ty] = t.split(',').map(Number)
          if (touchGoal(tx, ty)) {
            const tid = e.to.x + ',' + e.to.y + '#touch'
            if (!found || cur.d + e.cost < found.d) found = { node: { x: e.to.x, y: e.to.y }, via: { from: id, edge: e }, d: cur.d + e.cost, tid }
          }
        }
      }
      const nid = e.to.x + ',' + e.to.y
      const nd = cur.d + e.cost
      if (nd < (dist.get(nid) ?? Infinity)) {
        dist.set(nid, nd)
        prev.set(nid, { from: id, edge: e })
        open.push({ x: e.to.x, y: e.to.y, d: nd })
      }
    }
    if (found?.via && open.every((o) => o.d >= found.d)) break
  }
  return { start, reached, touched: touchedAll, found, prev }
}

function pathTo (res) {
  const steps = []
  let id
  if (res.found.via) {
    steps.unshift(res.found.via.edge)
    id = res.found.via.from
  } else id = res.found.node.x + ',' + res.found.node.y
  while (res.prev.has(id)) {
    const p = res.prev.get(id)
    steps.unshift(p.edge)
    id = p.from
  }
  return steps
}

// Targets the Agent (or a test) can name: an object id, exit, partner,
// gem (the nearest gem of one's own colour), or a cell: "x,y" from the
// Agent's tools, {x, y} from the solver and tests.
export function resolveTarget (W, kind, target) {
  const L = W.L
  const xy = typeof target === 'string' ? /^\s*\(?\s*(-?\d+)\s*[,，\s]\s*(-?\d+)\s*\)?\s*$/.exec(target) : null
  if (xy) target = { x: +xy[1], y: +xy[2] }
  if (target && typeof target === 'object' && Number.isFinite(+target.x) && Number.isFinite(+target.y)) {
    return { label: `(${+target.x},${+target.y})`, cells: [{ x: +target.x, y: +target.y }] }
  }
  const t = String(target ?? '').trim()
  const low = t.toLowerCase()
  if (low === 'exit' || low === 'door') return { label: '出口', cells: [L.exits[kind]] }
  if (low === 'partner') {
    const c = centreCell(W.heroes[other(kind)])
    return { label: '同伴', cells: [c, { x: c.x - 1, y: c.y }, { x: c.x + 1, y: c.y }] }
  }
  if (low === 'gem' || low === 'gems') {
    const cells = L.gems.filter((g) => g.kind === kind && !W.taken.has(g.id)).map((g) => ({ x: g.x, y: g.y, touch: true }))
    if (!cells.length) return { error: '你的宝石都已经拿到了' }
    return { label: '最近的宝石', cells }
  }
  const gem = L.gems.find((g) => g.id === low)
  if (gem) {
    if (gem.kind !== kind) return { error: `${gem.id} 是${HEROES[gem.kind].zh}的宝石，你拿不了` }
    if (W.taken.has(gem.id)) return { error: `${gem.id} 已经拿到了` }
    return { label: `宝石 ${gem.id}`, cells: [{ x: gem.x, y: gem.y, touch: true }] }
  }
  const o = L.byId.get(t) ?? L.byId.get(t.toUpperCase()) ?? L.byId.get(t.toLowerCase())
  if (!o) return { error: `没有叫 ${t} 的东西；可以用对象编号、exit、partner、gem、宝石编号或坐标 "x,y"` }
  if (o.type === 'button' || o.type === 'lever') return { label: `${o.type === 'button' ? '按钮' : '拉杆'} ${o.id}`, cells: [{ x: o.x, y: o.y }], obj: o }
  if (o.type === 'lift') {
    const y = Math.round(W.lifts[o.id]) - 1
    return { label: `升降台 ${o.id}`, cells: Array.from({ length: o.w }, (_, i) => ({ x: o.x + i, y })), obj: o }
  }
  // A gate: stand right next to it, on whichever side can be reached.
  const cells = []
  for (let yy = o.y; yy < o.y + o.h + 1; yy++) cells.push({ x: o.x - 1, y: yy }, { x: o.x + o.w, y: yy })
  return { label: `闸门 ${o.id}`, cells, obj: o }
}

// plan finds the way to a target. It returns { steps } where each step is
// a walk to a cell's centre or a program to play, or { error }.
export function plan (W, kind, target) {
  const t = resolveTarget(W, kind, target)
  if (t.error) return { error: t.error }
  const nodeSet = new Set(t.cells.filter((c) => !c.touch).map((c) => c.x + ',' + c.y))
  const touchSet = new Set(t.cells.filter((c) => c.touch).map((c) => c.x + ',' + c.y))
  const res = search(W, kind, (x, y) => nodeSet.has(x + ',' + y) || touchSet.has(x + ',' + y), touchSet.size ? (x, y) => touchSet.has(x + ',' + y) : null)
  if (!res.start) return { error: W.heroes[kind].alive ? '还在空中，落地后再走' : '已经倒下了' }
  if (!res.found) return { error: `到不了${t.label}`, label: t.label, unreachable: true }
  const edges = pathTo(res)
  const steps = []
  let cur = res.start
  steps.push({ walk: cur })
  for (const e of edges) {
    if (e.walk) {
      const last = steps[steps.length - 1]
      if (last.walk) last.walk = e.to
      else steps.push({ walk: e.to })
    } else {
      // Every program starts from the centre of its node.
      const last = steps[steps.length - 1]
      if (!last.walk || last.walk.x !== cur.x || last.walk.y !== cur.y) steps.push({ walk: cur })
      steps.push({ prog: e.prog, from: cur, to: e.to })
      steps.push({ walk: e.to })
    }
    cur = e.to
  }
  return { steps, label: t.label, obj: t.obj, target: t }
}

// reachable lists which named things a hero can get to from where it is.
export function reachable (W, kind) {
  const res = search(W, kind, null, null)
  if (!res.start) return null
  const L = W.L
  const has = (x, y) => res.reached.has(x + ',' + y)
  const out = []
  for (const o of [...L.buttons, ...L.levers]) if (has(o.x, o.y)) out.push(o.id)
  for (const l of L.lifts) {
    const y = Math.round(W.lifts[l.id]) - 1
    for (let i = 0; i < l.w; i++) if (has(l.x + i, y)) { out.push(l.id); break }
  }
  for (const g of L.gems) if (g.kind === kind && !W.taken.has(g.id) && (has(g.x, g.y) || res.touched.has(g.x + ',' + g.y))) out.push(g.id)
  const ex = L.exits[kind]
  if (has(ex.x, ex.y)) out.push('exit')
  return out
}

const centreX = (c) => c.x + 0.5 - P.w / 2

// moving: some gate or lift has not reached where its switches send it.
export function moving (W) {
  for (const g of W.L.gates) if (W.gates[g.id] !== (active(W, g) !== !!g.invert ? 1 : 0)) return true
  for (const l of W.L.lifts) if (W.lifts[l.id] !== liftWant(W, l)) return true
  return false
}

// Pilot drives one hero along a plan, frame by frame, and replans when the
// world moves under it (a lift, a gate, a missed landing).
export class Pilot {
  constructor (kind) {
    this.kind = kind
    this.task = null
  }

  // go starts a task: walk to the target, then optionally pull the lever
  // there. done(result) is called once with { ok, text }.
  go (W, target, opts = {}, done = () => {}) {
    this.cancel('换成了新的指令')
    this.task = { target, use: !!opts.use, done, tries: 0, steps: null, i: 0, f: 0, stuck: 0, lastX: null, wait: 0 }
    this.replan(W)
  }

  // raw plays one jump or a walk of n tiles.
  raw (W, prog, done = () => {}) {
    this.cancel('换成了新的指令')
    this.task = { raw: true, steps: [{ prog }], i: 0, f: 0, done, tries: 3 }
  }

  cancel (why) {
    const t = this.task
    this.task = null
    if (t) t.done({ ok: false, text: why, interrupted: true })
  }

  finish (ok, text) {
    const t = this.task
    this.task = null
    t?.done({ ok, text })
  }

  replan (W) {
    const t = this.task
    const p = plan(W, this.kind, t.target)
    if (p.error) {
      if (p.error.startsWith('还在空中')) { t.steps = null; t.wait = 6; return }
      // A gate or lift still moving may be about to open the way.
      if (p.unreachable && moving(W) && (t.settle = (t.settle ?? 0) + 1) < 40) { t.steps = null; t.wait = 6; return }
      this.finish(false, p.error)
      return
    }
    t.steps = p.steps
    t.label = p.label
    t.i = 0
    t.f = 0
    t.stuck = 0
  }

  get busy () { return !!this.task }

  // tick returns this frame's input for the hero.
  tick (W) {
    const t = this.task
    if (!t) return null
    const hero = W.heroes[this.kind]
    if (!hero.alive || W.status !== 'playing') return null
    if (!t.steps) {
      if (t.wait > 0) { t.wait--; return null }
      if (!hero.ground) return null
      this.replan(W)
      if (!this.task || !t.steps) return null
    }
    if (t.i >= t.steps.length) {
      if (!hero.ground) return null
      if (t.use) {
        t.use = false
        t.pulled = true
        return { x: 0, jump: false, use: true }
      }
      this.finish(true, t.raw ? '完成' : `到了${t.label ?? ''}${t.pulled ? '，拉了一下' : ''}`)
      return null
    }
    const s = t.steps[t.i]
    if (s.walk) {
      const tx = centreX(s.walk)
      const dx = tx - hero.x
      if (Math.abs(dx) < 1e-6 && hero.ground) {
        hero.x = tx
        t.i++
        t.stuck = 0
        return this.tick(W)
      }
      if (!hero.ground) {
        // Knocked off the route (a lift left, a gate closed): plan again.
        t.stuck++
        if (t.stuck > 40) return this.retry(W)
        return null
      }
      const before = hero.x
      const want = Math.max(-1, Math.min(1, dx / (P.speed * TICK)))
      if (t.lastX !== null && Math.abs(before - t.lastX) < 1e-7) {
        t.stuck++
        if (t.stuck > 20) return this.retry(W)
      } else t.stuck = 0
      t.lastX = before
      return { x: want, jump: false }
    }
    // A program: play it, then check the landing.
    if (t.f === 0 && !t.raw) {
      const at = landing(frozen(W), this.kind, hero)
      if (!at || at.x !== s.from.x || at.y !== s.from.y || Math.abs(hero.x - centreX(s.from)) > 1e-6) return this.retry(W)
    }
    const f = t.f++
    if (f > 0 && hero.ground) {
      t.i++
      t.f = 0
      t.lastX = null
      if (!t.raw) {
        const at = landing(frozen(W), this.kind, hero)
        if (!at || at.x !== s.to.x || at.y !== s.to.y) return this.retry(W)
      }
      return this.tick(W)
    }
    if (f > 200) return this.retry(W)
    return progInput(s.prog, f)
  }

  retry (W) {
    const t = this.task
    t.tries++
    if (t.tries > 4) { this.finish(false, `去${t.label ?? '目标'}的路上一直走不通（可能有东西在动），停下了`); return null }
    t.steps = null
    t.wait = 10
    return null
  }
}

// ------------------------------------------------------------ snapshots

// snapshot is the game state as plain JSON: what the browser sends the
// host, and what the Agent's view is drawn from.
export function snapshot (W) {
  const hero = (h) => ({ x: +h.x.toFixed(3), y: +h.y.toFixed(3), alive: h.alive, atExit: h.atExit, ground: !!h.ground, facing: h.facing })
  return {
    level: W.L.id,
    tick: W.tick,
    seconds: Math.floor(W.tick * TICK),
    status: W.status,
    cause: W.cause,
    heroes: { ember: hero(W.heroes.ember), rime: hero(W.heroes.rime) },
    taken: [...W.taken],
    levers: { ...W.levers },
    buttons: { ...W.buttons },
    gates: Object.fromEntries(Object.entries(W.gates).map(([k, v]) => [k, +v.toFixed(3)])),
    lifts: Object.fromEntries(Object.entries(W.lifts).map(([k, v]) => [k, +v.toFixed(3)]))
  }
}

// ------------------------------------------------------------ text view

const cellOfSnap = (h) => ({ x: Math.floor(h.x + P.w / 2), y: Math.floor(h.y + P.h - EPS) })

// textView draws the level for the Agent playing `me`: a character grid
// with row and column numbers, then the objects and what they do.
export function textView (L, s, me, extra = {}) {
  const grid = []
  for (let y = 0; y < L.h; y++) {
    const row = []
    for (let x = 0; x < L.w; x++) {
      const i = y * L.w + x
      row.push(L.solid[i] ? '#' : L.ledge[i] ? '=' : L.liquid[i] === 'lava' ? '^' : L.liquid[i] === 'frost' ? '~' : L.liquid[i] === 'ooze' ? '%' : '.')
    }
    grid.push(row)
  }
  const put = (x, y, ch) => { if (y >= 0 && y < L.h && x >= 0 && x < L.w) grid[y][x] = ch }
  const taken = new Set(s?.taken ?? [])
  for (const g of L.gems) if (!taken.has(g.id)) put(g.x, g.y, g.kind === 'ember' ? '*' : 'o')
  put(L.exits.ember.x, L.exits.ember.y, 'E')
  put(L.exits.rime.x, L.exits.rime.y, 'R')
  for (const o of [...L.buttons, ...L.levers]) put(o.x, o.y, o.id)
  for (const g of L.gates) {
    const f = s?.gates?.[g.id] ?? 0
    for (let yy = 0; yy < g.h; yy++) for (let xx = 0; xx < g.w; xx++) put(g.x + xx, g.y + yy, f >= 1 ? ':' : g.id)
  }
  for (const l of L.lifts) {
    const y = Math.round(s?.lifts?.[l.id] ?? l.y)
    for (let xx = 0; xx < l.w; xx++) put(l.x + xx, y, l.id)
  }
  if (s) {
    for (const k of KINDS) {
      const h = s.heroes[k]
      if (!h.alive) continue
      const c = cellOfSnap(h)
      put(c.x, c.y, k === me ? '@' : '&')
    }
  }
  const tens = '   ' + Array.from({ length: L.w }, (_, x) => (x % 10 === 0 ? String(x / 10 % 10) : ' ')).join('')
  const ones = '   ' + Array.from({ length: L.w }, (_, x) => String(x % 10)).join('')
  const lines = [tens, ones, ...grid.map((r, y) => String(y).padStart(2, ' ') + ' ' + r.join(''))]

  const youK = me
  const pal = other(me)
  const out = []
  out.push(`关卡 ${L.id}「${L.name}」${s ? ` · ${s.seconds}s · ${statusZh(s)}` : ''}`)
  out.push(`你是${HEROES[youK].zh}（${HEROES[youK].en}，@），${youK === 'ember' ? '火：不怕熔岩 ^，碰到寒潭 ~ 或毒沼 % 会倒下' : '冰：不怕寒潭 ~，碰到熔岩 ^ 或毒沼 % 会倒下'}；同伴${HEROES[pal].zh}（&）${pal === 'ember' ? '不怕熔岩 ^' : '不怕寒潭 ~'}。`)
  out.push('')
  out.push(...lines)
  out.push('')
  out.push('图例：# 墙  = 单向平台（能站，从下面能跳上去）  . 空  ^ 熔岩  ~ 寒潭  % 毒沼  * 烬的宝石  o 凇的宝石  E 烬的出口  R 凇的出口  : 开着的闸门；字母是对象（见下）。坐标 x 向右、y 向下。')
  if (s) {
    for (const k of [youK, pal]) {
      const h = s.heroes[k]
      const c = cellOfSnap(h)
      out.push(`${k === youK ? '你' : '同伴'}（${HEROES[k].zh}）：${h.alive ? `在 (${c.x},${c.y})${h.ground ? '' : '，在空中'}${h.atExit ? '，站在出口' : ''}` : '倒下了'}`)
    }
  }
  const objs = []
  for (const b of L.buttons) objs.push(`${b.id} 按钮 (${b.x},${b.y})：${s?.buttons?.[b.id] ? '被踩着' : '没人踩'}；站上去才算按下，离开就弹起`)
  for (const l of L.levers) objs.push(`${l.id} 拉杆 (${l.x},${l.y})：${s?.levers?.[l.id] ? '已拉下（开）' : '未拉（关）'}；站在上面拉一下切换`)
  const drivers = (o) => o.by.length > 1 ? (o.all ? o.by.join(' 和 ') + ' 都' : o.by.join(' 或 ') + ' ') : o.by[0] + ' '
  for (const g of L.gates) {
    const f = s?.gates?.[g.id] ?? 0
    objs.push(`${g.id} 闸门 x=${g.x}${g.w > 1 ? '..' + (g.x + g.w - 1) : ''} y=${g.y}..${g.y + g.h - 1}：${f >= 1 ? '开着' : f > 0 ? '正在动' : '关着'}；${g.invert ? `${drivers(g)}打开时它关上` : `${drivers(g)}打开时它开`}`)
  }
  for (const l of L.lifts) {
    const y = s?.lifts?.[l.id] ?? l.y
    objs.push(`${l.id} 升降台 x=${l.x}..${l.x + l.w - 1}：现在在 y=${Math.round(y * 10) / 10}（底 y=${l.y}，顶 y=${l.y + l.dy}）；${l.invert ? `平时在顶，${drivers(l)}打开时降到底` : `${drivers(l)}打开时升到顶，否则回到底`}`)
  }
  if (objs.length) {
    out.push('对象：')
    for (const o of objs) out.push('- ' + o)
  }
  const gems = L.gems.filter((g) => g.kind === youK)
  if (gems.length) {
    const left = gems.filter((g) => !taken.has(g.id))
    out.push(`你的宝石：${gems.length - left.length}/${gems.length}${left.length ? '，还剩 ' + left.map((g) => `${g.id}(${g.x},${g.y})`).join(' ') : ''}（可选，拿不拿都能过关）`)
  }
  if (extra.reach) out.push(`你现在走得到：${extra.reach.length ? extra.reach.join(' ') : '（附近没有可去的对象）'}`)
  if (L.tip) out.push(`提示：${L.tip}`)
  return out.join('\n')
}

export function statusZh (s) {
  if (s.status === 'complete') return '过关'
  if (s.status === 'dead') return `${HEROES[s.cause?.who]?.zh ?? ''}倒下了${s.cause?.liquid ? `（${LIQUID_ZH[s.cause.liquid]}）` : ''}，关卡重开中`
  return '进行中'
}
