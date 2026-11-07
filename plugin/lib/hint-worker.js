import { parentPort, workerData } from 'node:worker_threads'
import { hint, route } from './solver.js'

// One search per worker: the next moves to clear the level, or, with a
// target, what has to happen before the Agent can reach it.
const { snap, me, target } = workerData
const r = target ? route(snap, me, target, { ms: 4000 }) : hint(snap, me, { ms: 8000 })
parentPort.postMessage(r && { ok: r.ok, text: r.text })
