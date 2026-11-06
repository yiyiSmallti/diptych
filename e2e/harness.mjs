// Shared pieces of the end-to-end runs: the report, a real dsh driven over
// its SDK protocol, a fake model, and an npm tarball packer. Node
// built-ins only.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export const E2E = import.meta.dirname
export const ROOT = path.dirname(E2E)
export const REPORT = path.join(E2E, 'report')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// attempt runs fn and returns the error it threw, or null.
export async function attempt (fn) {
  try {
    await fn()
    return null
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

export const check = (cond, message) => cond ? null : new Error(message)

export function clip (s, n) {
  const r = [...String(s)]
  return r.length > n ? r.slice(0, n).join('') + '…' : String(s)
}

export function tail (s, n) {
  const lines = String(s).replace(/\n+$/, '').split('\n')
  return lines.slice(-n).join('\n')
}

export const count = (s, sub) => s.split(sub).length - 1
// goList prints a list the way the report has always shown one: [a b].
export const goList = (a) => '[' + a.join(' ') + ']'

// ---------------------------------------------------------------- report

export class Report {
  sections = []

  section (title) {
    const s = new Section(title)
    this.sections.push(s)
    return s
  }

  get fails () { return this.sections.reduce((n, s) => n + s.fails, 0) }

  write () {
    if (!this.sections.length) return
    const total = this.sections.reduce((n, s) => n + s.lines.length, 0)
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const zone = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop()
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${zone}`
    let b = `# diptych 端到端报告\n\n${stamp} · ${process.platform}/${process.arch}\n\n结果：${total} 步，失败 ${this.fails}。\n`
    for (const s of this.sections) {
      b += `\n## ${s.title}\n\n| | 步骤 | 详情 |\n| --- | --- | --- |\n${s.lines.join('\n')}\n${s.appendix}`
    }
    fs.mkdirSync(REPORT, { recursive: true })
    fs.writeFileSync(path.join(REPORT, 'diptych-e2e.md'), b)
  }
}

class Section {
  lines = []
  fails = 0
  appendix = ''

  constructor (title) { this.title = title }

  // step records one line and reports whether it passed.
  step (name, err, detail = '') {
    let mark = '✅'
    if (err) {
      mark = '❌'
      this.fails++
      console.error(`FAIL ${name}: ${err.message}`)
      if (detail) detail += '；'
      detail += '错误：' + err.message
    } else {
      console.log(`ok   ${name}`)
    }
    detail = detail.replaceAll('|', '\\|').replaceAll('\n', '<br>')
    this.lines.push(`| ${mark} | ${name} | ${detail} |`)
    return !err
  }
}

// keep copies a generated file into the report directory.
export function keep (src, name) {
  try {
    const data = fs.readFileSync(src)
    fs.mkdirSync(REPORT, { recursive: true })
    fs.writeFileSync(path.join(REPORT, name), data)
  } catch {}
}

// Cleanup runs registered undo functions last-in first-out.
export class Cleanup {
  fns = []
  add (fn) { this.fns.push(fn) }
  async run () {
    for (const fn of this.fns.reverse()) {
      try { await fn() } catch {}
    }
    this.fns = []
  }
}

// shortTemp keeps socket paths under macOS's 104-byte limit.
export function shortTemp (cleanup) {
  const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'diptych-e2e-'))
  cleanup.add(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function which (name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, name)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile()) return p
    } catch {}
  }
  return ''
}

// run runs a command to the end (3 minutes at most) and returns its
// combined output; a failure carries the output as err.out.
export function run (env, dir, name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(name, args, { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), 3 * 60 * 1000)
    const fail = (why) => {
      const err = new Error(`${name} ${args.join(' ')}: ${why}\n${tail(out, 20)}`)
      err.out = out
      reject(err)
    }
    child.on('error', (err) => { clearTimeout(timer); fail(err.message) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else fail(signal ? `signal: ${signal}` : `exit status ${code}`)
    })
  })
}

// ------------------------------------------------------------- JSON-RPC

// RpcConn is a JSON-RPC 2.0 endpoint over a stream, one frame per line:
// dsh's SDK protocol on stdio, spoken here as the client.
class RpcConn {
  next = 0
  pending = new Map()
  closed = false

  constructor (readable, writable, onRequest) {
    this.w = writable
    let buf = ''
    readable.setEncoding('utf8')
    readable.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        this.#frame(line, onRequest)
      }
    })
    readable.on('close', () => this.#shut())
    readable.on('error', () => this.#shut())
    writable.on('error', () => {})
  }

  #frame (line, onRequest) {
    let f
    try { f = JSON.parse(line) } catch { return }
    if (!f || typeof f !== 'object') return
    if (f.id != null && f.method) {
      let error
      try { onRequest(f.method, f.params) } catch (err) { error = err }
      const out = { jsonrpc: '2.0', id: f.id }
      if (error) out.error = { code: error.code ?? -32603, message: error.message }
      else out.result = null
      this.#send(out)
    } else if (f.id != null) {
      const p = this.pending.get(String(f.id))
      this.pending.delete(String(f.id))
      if (!p) return
      if (f.error) p.reject(new Error(`jsonrpc ${f.error.code}: ${f.error.message}`))
      else p.resolve(f.result)
    }
  }

  #send (f) {
    if (!this.w.writable) return
    this.w.write(JSON.stringify(f) + '\n')
  }

  #shut () {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) p.reject(new Error('jsonrpc: connection closed'))
    this.pending.clear()
  }

  // call sends a request and waits for its result until deadline (ms epoch).
  call (method, params, deadline) {
    if (this.closed) return Promise.reject(new Error('jsonrpc: connection closed'))
    const left = deadline - Date.now()
    if (left <= 0) return Promise.reject(new Error('context deadline exceeded'))
    const id = String(++this.next)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('context deadline exceeded'))
      }, left)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      const f = { jsonrpc: '2.0', id: Number(id), method }
      if (params != null) f.params = params
      this.#send(f)
    })
  }
}

// ----------------------------------------------------------------- dsh

export function findDsh () {
  return process.env.DIPTYCH_E2E_DSH || which('dsh')
}

export class Dsh {
  constructor (bin, work) {
    this.bin = bin
    this.work = work
    this.env = { DSH_HOME: path.join(work, 'dsh-home') }
  }

  argv (...args) {
    if (this.bin.endsWith('.js')) return [process.env.DIPTYCH_E2E_NODE || 'node', this.bin, ...args]
    return [this.bin, ...args]
  }

  run (...args) {
    const [cmd, ...rest] = this.argv(...args)
    return run(this.env, this.work, cmd, rest)
  }

  // install makes an sdk-template profile with the packages and returns
  // dsh's version and the profile's dump-config.
  async install (profile, ...tgzs) {
    let ver = ''
    try { ver = await this.run('--version') } catch (err) { ver = err.out ?? '' }
    await this.run('--profile', profile, '--from-default-profile', 'sdk', '--dump-config')
    for (const tgz of tgzs) await this.run('plugin', '--profile', profile, 'add', tgz)
    const dump = await this.run('--profile', profile, '--dump-config')
    return { ver: ver.trim(), dump }
  }

  // turn runs one dsh session turn in cwd with the fake model, over the SDK
  // protocol on stdio. It returns dsh's stderr and the error, if any.
  async turn (profile, cwd, model, prompt) {
    const [cmd, ...rest] = this.argv('--profile', profile)
    const child = spawn(cmd, rest, {
      cwd,
      env: { ...process.env, ...this.env, DEEPSEEK_API_KEY: 'sk-diptych-e2e', DEEPSEEK_BASE_URL: model.url },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    const exited = new Promise((resolve) => child.on('close', resolve))
    const started = await new Promise((resolve) => {
      child.on('spawn', () => resolve(null))
      child.on('error', resolve)
    })
    if (started) return { stderr: '', err: started }
    const asked = []
    const conn = new RpcConn(child.stdout, child.stdin, (method) => {
      asked.push(method)
      throw Object.assign(new Error(`the e2e client has no ${method}`), { code: -32601 })
    })
    const deadline = Date.now() + 4 * 60 * 1000
    const err = await attempt(async () => {
      await conn.call('initialize', { cwd, provider: 'deepseek-official', model: 'deepseek-flash' }, deadline)
      await conn.call('session/prompt', { sessionId: 'main-diptych-e2e', contentBlocks: [{ type: 'text', text: prompt }] }, deadline)
      await conn.call('session/wait', { sessionId: 'main-diptych-e2e' }, deadline)
    })
    await conn.call('shutdown', null, Date.now() + 5000).catch(() => {})
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
    await exited
    clearTimeout(timer)
    if (asked.length) stderr += '\n[e2e] dsh asked the client: ' + asked.join(', ')
    return { stderr, err }
  }
}

// ----------------------------------------------------------- fake model

const contentText = (v) => typeof v === 'string' ? v : Array.isArray(v) ? v.map((b) => b?.text ?? '').join('\n') : ''

// startModel serves the Anthropic Messages API dsh's DeepSeek adapter
// uses. script is either a list of tool calls, made in order, one per
// request, or a function of the model's state (m) that returns the next
// call, or null to answer with text (reply). It records each tool_result it
// receives, the tools it was offered, the system prompt, and the text of
// the latest request.
export async function startModel (cleanup, script = [], reply = 'done') {
  const m = { url: '', script, reply, results: [], tools: [], system: '', prompt: '', images: 0, requests: 0 }
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (d) => { body += d })
    req.on('end', () => serve(m, req, res, body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  m.url = `http://127.0.0.1:${server.address().port}`
  cleanup.add(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  return m
}

function serve (m, req, res, body) {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.includes('/files')) {
    // No Files API here: images go inline in the request.
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404 page not found\n')
    return
  }
  if (!url.pathname.endsWith('/messages')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[]}')
    return
  }
  let r = {}
  try { r = JSON.parse(body) ?? {} } catch {}
  const results = []
  const texts = []
  let images = 0
  for (const msg of r.messages ?? []) {
    texts.push(contentText(msg?.content))
    if (!Array.isArray(msg?.content)) continue
    for (const b of msg.content) {
      if (b?.type === 'image') images++
      if (b?.type === 'tool_result') results.push({ text: contentText(b.content), isError: !!b.is_error })
    }
  }
  m.results = results
  m.tools = (r.tools ?? []).map((t) => t?.name)
  m.system = contentText(r.system)
  m.prompt = texts.join('\n')
  m.images = images

  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  const nano = () => process.hrtime.bigint().toString()
  ev('message_start', {
    type: 'message_start',
    message: { id: `msg_${nano()}`, type: 'message', role: 'assistant', model: r.model ?? '', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } }
  })
  let stop = 'end_turn'
  m.requests++
  const n = results.length
  const call = typeof m.script === 'function' ? m.script(m) : m.script[n]
  if (call) {
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${n}_${nano()}`, name: call.name, input: {} } })
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })
    stop = 'tool_use'
  } else {
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: m.reply } })
  }
  ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } })
  ev('message_stop', { type: 'message_stop' })
  res.end()
}

// gameTools is the tools the model was offered that diptych registers.
export const gameTools = (tools) => tools.filter((n) => /^diptych_/.test(n))

// packPlugin packs ../plugin as npm would publish it (package/…), without
// local tarballs, and returns the .tgz path.
export function packPlugin (work) {
  const dir = path.join(ROOT, 'plugin')
  const blocks = []
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const r = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) walk(r)
      else if (d.isFile() && !r.endsWith('.tgz')) blocks.push(tarEntry('package/' + r, fs.readFileSync(path.join(dir, r))))
    }
  }
  walk('')
  blocks.push(Buffer.alloc(1024))
  const out = path.join(work, 'plugin.tgz')
  fs.writeFileSync(out, zlib.gzipSync(Buffer.concat(blocks)))
  return out
}

function tarEntry (name, data) {
  const h = Buffer.alloc(512)
  const put = (s, at, len) => h.write(s, at, len, 'utf8')
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0'
  let prefix = ''
  if (Buffer.byteLength(name) > 100) {
    const i = name.lastIndexOf('/', 155)
    prefix = name.slice(0, i)
    name = name.slice(i + 1)
  }
  put(name, 0, 100)
  put(oct(0o644, 8), 100, 8)
  put(oct(0, 8), 108, 8)
  put(oct(0, 8), 116, 8)
  put(oct(data.length, 12), 124, 12)
  put(oct(499162500, 12), 136, 12)
  put('        ', 148, 8)
  put('0', 156, 1)
  put('ustar\u000000', 257, 8)
  put(prefix, 345, 155)
  let sum = 0
  for (const b of h) sum += b
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  const pad = Buffer.alloc((512 - data.length % 512) % 512)
  return Buffer.concat([h, data, pad])
}
