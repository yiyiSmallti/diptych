// End-to-end runs of diptych, the only test mechanism of this repository.
// They drive the real pieces and write report/diptych-e2e.md, with
// screenshots beside it:
//
//   - solve: every level solved by e2e/solver.mjs (two autopilots in Node, on
//     the engine the browser runs): it clears, every gem is reachable,
//     and it needs both heroes.
//   - host: real dsh with the package; the model's tools and prompt.
//   - web: dsh web with the package, driven by a headless Chrome: the
//     person plays one hero with the keyboard, a fake Agent the other
//     through the real tools, and they clear a level together.
//
// node e2e/run.mjs [solve] [host] [web]   (no argument runs all)
// Needs node and dsh 0.2.x (on PATH, or DIPTYCH_E2E_DSH: an executable or
// bin.js run with DIPTYCH_E2E_NODE); the web run also Chrome or Edge
// (DIPTYCH_E2E_CHROME).
import { Report } from './harness.mjs'
import { solve } from './solve.mjs'
import { host } from './host.mjs'
import { web } from './web.mjs'

const suites = { solve, host, web }
const pick = process.argv.slice(2)
for (const name of pick) {
  if (!suites[name]) {
    console.error(`unknown suite ${name}; have: ${Object.keys(suites).join(', ')}`)
    process.exit(2)
  }
}
const rep = new Report()
for (const [name, fn] of Object.entries(suites)) {
  if (pick.length && !pick.includes(name)) continue
  try {
    await fn(rep)
  } catch (err) {
    rep.section(name).step('运行到底', err)
  }
}
rep.write()
const total = rep.sections.reduce((n, s) => n + s.lines.length, 0)
console.log(`\n${total} steps, ${rep.fails} failed; report: e2e/report/diptych-e2e.md`)
process.exit(rep.fails ? 1 : 0)
