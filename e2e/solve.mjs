// Solver suite: every level is solved in Node by e2e/solver.mjs, which
// plays the two heroes' autopilots on the engine the browser runs. For
// each level it checks that the level can be cleared, that every gem can
// be reached, and that it needs both heroes: neither reaches its exit
// while the other stands still.
import { LEVELS, engine, solveLevel, describe, hint } from './solver.mjs'

const { TICK, createWorld, level, step, snapshot } = engine

export async function solve (rep) {
  const s = rep.section(`关卡：自动解关器打通全部 ${LEVELS.length} 关（Node，同一个引擎，两个自动驾驶）`)
  for (const def of LEVELS) {
    let r = null
    let err = null
    try { r = solveLevel(def.id) } catch (e) { err = e }
    const label = `第 ${def.id} 关「${def.name}」`
    if (err || !r.ok) {
      s.step(`${label}能过关`, err ?? new Error('解关器找不到解法'))
      continue
    }
    const fails = []
    if (r.missingGems.length) fails.push(`拿不到宝石 ${r.missingGems.join('、')}`)
    if (r.alone.length) fails.push(`${r.alone.join('、')} 不用同伴帮忙就能走到出口`)
    s.step(`${label}能过关、宝石都拿得到、两人缺一不可`, fails.length ? new Error(fails.join('；')) : null,
      `${r.path.length} 步，${(r.W.tick * TICK).toFixed(1)} 秒游戏时间：${r.path.map(describe).join(' → ')}（${r.ms} ms）`)
  }

  // The hint the Agent gets after a few misses, from the spot a real game
  // got stuck in: Ember up top with lever v pulled, the lift locked up
  // there, and Rime (the Agent) left at the bottom.
  const W = createWorld(level('2'))
  Object.assign(W.heroes.ember, { x: 18.2, y: 2.1 })
  Object.assign(W.heroes.rime, { x: 5.2, y: 8.1 })
  W.levers.v = true
  for (let i = 0; i < 200; i++) step(W, {})
  const h = hint(snapshot(W), 'rime')
  s.step('提示：第 2 关凇被留在底下时，解关器让同伴先拉回 v、凇站上升降台 P、再拉 v', h?.ok && /1\. 请同伴（烬）去拉拉杆 v；2\. 你站上升降台 P；3\. 请同伴（烬）去拉拉杆 v/.test(h.text) ? null : new Error(h?.text ?? '没有提示'), h?.text)
}
