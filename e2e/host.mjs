// Host suite: real dsh (sdk template + this package) over its SDK
// protocol, with no browser. The model is offered the three game tools and
// the prompt section, and a tool call without an open game says plainly
// what the person has to do.
import fs from 'node:fs'
import path from 'node:path'
import { Cleanup, Dsh, attempt, check, findDsh, gameTools, goList, packPlugin, shortTemp, startModel } from './harness.mjs'

export async function host (rep) {
  const s = rep.section('dsh（sdk 模板）：工具、提示词、没开游戏时的回答')
  const cleanup = new Cleanup()
  try {
    const bin = findDsh()
    if (!bin) { s.step('找到 dsh', new Error('PATH 上没有 dsh，也没有 DIPTYCH_E2E_DSH')); return }
    const work = shortTemp(cleanup)
    const ws = path.join(work, 'ws')
    fs.mkdirSync(ws, { recursive: true })
    const d = new Dsh(bin, work)
    let info
    let err = await attempt(async () => { info = await d.install('diptych-e2e', packPlugin(work)) })
    if (!s.step('打包本插件，装进 sdk 模板 profile', err, info ? `dsh ${info.ver}` : '')) return
    const model = await startModel(cleanup, [
      { name: 'diptych_look', input: {} },
      { name: 'diptych_act', input: { action: 'go', target: 'exit' } },
      { name: 'diptych_wait', input: { seconds: 1 } }
    ], '好的')
    const turn = await d.turn('diptych-e2e', ws, model, '来玩双联画')
    s.step('跑一轮：模型依次调用三个工具', turn.err, `模型请求 ${model.requests} 次`)
    const tools = gameTools(model.tools)
    s.step('模型拿到 diptych_look / diptych_act / diptych_wait', check(tools.length === 3, `只有 ${goList(tools)}`), goList(tools))
    s.step('系统提示里有双联画一节', check(model.system.includes('Diptych（双联画）') && model.system.includes('diptych_act'), '系统提示里没有'))
    const r = model.results
    s.step('没开游戏时三个工具都报错，并说清要在右侧边栏打开「双联画」',
      check(r.length === 3 && r.every((x) => x.isError && x.text.includes('右侧边栏') && x.text.includes('双联画')), JSON.stringify(r).slice(0, 300)),
      r[0]?.text?.slice(0, 80) ?? '')
  } finally {
    await cleanup.run()
  }
}
