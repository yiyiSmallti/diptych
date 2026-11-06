// Solver suite: every level is solved in Node by e2e/solver.mjs, which
// plays the two heroes' autopilots on the engine the browser runs. For
// each level it checks that the level can be cleared, that every gem can
// be reached, and that it needs both heroes: neither reaches its exit
// while the other stands still.
import { LEVELS, engine, solveLevel, describe } from './solver.mjs'

const { TICK } = engine

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
}
