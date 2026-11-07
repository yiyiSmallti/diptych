// Runs the solver for one hint off the dsh process's main thread: the
// harder levels take a few seconds to search (lib/index.js).
import { parentPort, workerData } from 'node:worker_threads'
import { hint } from './solver.js'

const r = hint(workerData.snap, workerData.me, { ms: 8000 })
parentPort.postMessage(r && { ok: r.ok, text: r.text })
