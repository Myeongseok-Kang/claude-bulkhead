'use strict'
const os = require('os')
const path = require('path')
const { stateDir } = require('./hook')
const { tailEvents } = require('./events')
const { limits } = require('./slots')
const { size, when } = require('./status')
const { useColor, paint, shortPath, option, fit } = require('./cli-util')

const USAGE = `usage: bulkhead top [--interval=SECONDS] [--once]

A live view of the Claude Code sessions on this machine, their memory, child processes
and ports, the bulkhead-slot jobs and queue, free RAM, and the latest blocks.
Keys: q or Ctrl-C quits, r refreshes now.
When the output is not a terminal, or with --once, it prints one snapshot and exits.`

const ESC = '\x1b['
const ALT_ON = `${ESC}?1049h`
const ALT_OFF = `${ESC}?1049l`
const HIDE = `${ESC}?25l`
const SHOW = `${ESC}?25h`
const HOME = `${ESC}H`
const CLEAR_EOL = `${ESC}K`
const CLEAR_EOS = `${ESC}J`
const SPINNER = '|/-\\'

function defaultInterval(platform = process.platform) {
  return platform === 'win32' ? 4000 : 2000
}

function meter(fraction, width) {
  const n = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return '█'.repeat(n) + '░'.repeat(width - n)
}

// Plain cell of exactly `width` columns.
const cell = (s, width, right = false) => {
  const t = fit(s, width)
  return right ? t.padStart(width) : t.padEnd(width)
}

// Session table columns. When the terminal is narrow, columns go in `drop` order, then the
// project column shrinks. Widths are fixed except the project and ports columns.
const COLUMNS = [
  { key: 'pid', title: 'PID', width: 7 },
  { key: 'started', title: 'STARTED', width: 12, drop: 2 },
  { key: 'project', title: 'PROJECT', width: 12, flex: true },
  { key: 'rss', title: 'RSS', width: 7, right: true },
  { key: 'bar', title: '', width: 10, drop: 1 },
  { key: 'procs', title: 'PROCS', width: 5, right: true, drop: 4 },
  { key: 'ports', title: 'PORTS', width: 6, grow: 22, drop: 3 },
]

function layout(width) {
  let cols = COLUMNS.slice()
  const total = cs => cs.reduce((n, c) => n + c.width, 0) + (cs.length - 1) * 2
  for (const d of [1, 2, 3, 4]) {
    if (total(cols) <= width) break
    cols = cols.filter(c => c.drop !== d)
  }
  cols = cols.map(c => ({ ...c }))
  let spare = width - total(cols)
  const ports = cols.find(c => c.key === 'ports')
  if (ports && spare > 0) {
    const add = Math.min(spare, ports.grow - ports.width)
    ports.width += add
    spare -= add
  }
  const project = cols.find(c => c.key === 'project')
  project.width = Math.max(4, project.width + spare)
  return cols
}

// One screen as an array of lines, each at most `width` visible columns.
function frame(view, { width = 100, height = 40, color = false, home = os.homedir() } = {}) {
  width = Math.max(24, width)
  const c = (style, s) => paint(color, style, s)
  const lines = []
  const st = view.st
  const now = view.now || Date.now()
  const d = new Date(now)
  const clock = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')

  // header
  const state = view.scanning ? `scanning ${SPINNER[(view.tick || 0) % 4]}` : view.lastScanMs != null ? `scan ${(view.lastScanMs / 1000).toFixed(1)}s` : ''
  const left = `bulkhead top  ${clock}`
  const right = `${state}  every ${Math.round(view.interval / 1000)}s  q quit  r refresh`
  const gap = width - left.length - right.length
  if (gap >= 2) lines.push(c('bold', left) + ' '.repeat(gap) + (view.scanning ? c('yellow', right.slice(0, state.length)) + right.slice(state.length) : right))
  else lines.push(c('bold', fit(`${left}  ${state}`, width)))

  if (!st) {
    lines.push('', view.error ? c('red', fit(`scan failed: ${view.error}`, width)) : 'reading processes...')
    return lines
  }

  // memory
  const m = st.memory
  const lim = limits(m.totalGb)
  const used = m.totalGb - m.freeGb
  const low = m.freeGb < lim.minFreeGb
  const tight = m.freeGb < lim.floorGb
  const extra = [
    m.commitPct != null ? `commit ${m.commitPct}%` : null,
    m.swapTotalGb ? `swap ${m.swapUsedGb.toFixed(1)}/${m.swapTotalGb.toFixed(1)} GB` : null,
  ].filter(Boolean).join('  ')
  const memText = `${m.freeGb.toFixed(1)} GB free of ${m.totalGb.toFixed(1)} GB` + (extra ? `  ${extra}` : '')
  const barWidth = Math.max(0, Math.min(30, width - memText.length - 7))
  const barStyle = low ? 'red' : tight ? 'yellow' : 'green'
  lines.push((barWidth >= 5 ? `RAM ${c(barStyle, meter(used / m.totalGb, barWidth))}  ` : 'RAM ') + fit(memText, width - (barWidth >= 5 ? barWidth + 6 : 4)))
  if (low) lines.push(c('red', fit(`below ${lim.minFreeGb} GB: memory-guard is blocking heavy commands`, width)))
  lines.push('')

  // sessions
  const sessions = st.sessions
  const cols = layout(width)
  lines.push(c('bold', fit(`SESSIONS ${sessions.length}`, width)))
  lines.push(c('dim', cols.map(col => cell(col.title, col.width, col.right)).join('  ').trimEnd()))
  const maxRss = Math.max(1, ...sessions.map(s => s.rss))

  // what has to fit below the session rows
  const slotRows = st.slots.length + (st.queue || []).length
  const events = view.events || []
  const below = 2 + (slotRows ? slotRows + 1 : 1) + 2 + Math.max(1, events.length)
  const room = Math.max(1, height - lines.length - below)
  const shown = sessions.length > room ? sessions.slice(0, Math.max(0, room - 1)) : sessions
  for (const s of shown) {
    const parts = cols.map(col => {
      switch (col.key) {
        case 'pid': return cell(s.pid, col.width)
        case 'started': return cell(when(s.start, now), col.width)
        case 'project': return cell(shortPath(s.cwd, home), col.width)
        case 'rss': return cell(size(s.rss), col.width, true)
        case 'bar': return c('cyan', meter(s.rss / maxRss, col.width))
        case 'procs': return cell(s.children == null ? '-' : s.children, col.width, true)
        case 'ports': return cell(s.ports.map(p => `:${p.port}`).join(' ') || '-', col.width)
      }
      return ''
    })
    lines.push(parts.join('  ').trimEnd())
  }
  if (shown.length < sessions.length) lines.push(c('dim', fit(`... ${sessions.length - shown.length} more`, width)))
  if (!sessions.length) lines.push(c('dim', 'no Claude sessions found'))
  lines.push('')

  // slots and queue
  const queue = st.queue || []
  lines.push(c('bold', fit(`HEAVY JOBS  ${st.slots.length} running, ${queue.length} waiting`, width)))
  for (const s of st.slots) {
    lines.push(fit(`${cell(s.slot, 7)} ${cell(`${s.gb} GB`, 6)} ${cell(s.pid, 7)} ${cell(`${Math.round((now - s.at) / 60000)} min`, 7)} ${s.label}`, width))
  }
  queue.forEach((q, i) => {
    lines.push(c('yellow', fit(`${cell(`wait #${i + 1}`, 7)} ${cell(`${q.gb} GB`, 6)} ${cell(q.pid, 7)} ${cell(`${Math.round((now - q.at) / 60000)} min`, 7)} ${q.label}  (${q.reason})`, width)))
  })
  if (!slotRows) lines.push(c('dim', 'none'))
  lines.push('')

  // recent blocks
  lines.push(c('bold', 'RECENT BLOCKS'))
  if (!events.length) lines.push(c('dim', 'none recorded'))
  for (const e of events.slice().reverse()) {
    const t = new Date(e.time)
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    lines.push(fit(`${hm}  ${cell(e.guard, 14)} ${cell(e.rule || '', 14)} ${cell(shortPath(e.project, home), 18)} ${e.command || ''}`, width))
  }
  return lines.slice(0, Math.max(1, height))
}

// The process scan in a worker thread, so the screen and keys never wait for it.
function workerScanner() {
  const { Worker } = require('worker_threads')
  let worker = null
  let pending = null
  const start = () => {
    worker = new Worker(path.join(__dirname, 'top-worker.js'))
    worker.unref()
    worker.on('message', msg => {
      const p = pending
      pending = null
      if (p) (msg.ok ? p.resolve(msg) : p.reject(Object.assign(new Error(msg.error), { ms: msg.ms })))
    })
    worker.on('error', e => {
      const p = pending
      pending = null
      worker = null
      if (p) p.reject(e)
    })
  }
  return {
    scan() {
      if (!worker) start()
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
        worker.postMessage('scan')
      })
    },
    close() {
      if (worker) worker.terminate()
      worker = null
    },
  }
}

// Live loop. Resolves when the user quits. Every dependency can be replaced for tests.
function live({
  stdin = process.stdin, stdout = process.stdout, env = process.env, interval = defaultInterval(),
  scanner = workerScanner(), events = () => tailEvents(stateDir(), 5), proc = process,
} = {}) {
  const color = useColor(stdout, env)
  const view = { st: null, scanning: false, lastScanMs: null, interval, tick: 0, events: [], error: null }
  let timer = null
  let clock = null
  let closed = false
  let again = false
  let resolveDone
  const done = new Promise(r => (resolveDone = r))

  const draw = () => {
    if (closed) return
    view.now = Date.now()
    const lines = frame(view, { width: stdout.columns || 80, height: stdout.rows || 24, color })
    stdout.write(HOME + lines.map(l => l + CLEAR_EOL).join('\r\n') + CLEAR_EOS)
  }

  const refresh = () => {
    if (closed) return
    if (view.scanning) { again = true; return }
    view.scanning = true
    draw()
    scanner.scan().then(msg => {
      view.st = msg.st
      view.lastScanMs = msg.ms
      view.error = null
    }, e => {
      view.error = e.message
    }).then(() => {
      view.scanning = false
      try { view.events = events() } catch { view.events = [] }
      draw()
      if (again) {
        again = false
        refresh()
      }
    })
  }

  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    clearInterval(clock)
    try { scanner.close() } catch {}
    stdin.removeListener('data', onKey)
    stdout.removeListener('resize', draw)
    try { if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false) } catch {}
    try { stdin.pause() } catch {}
    stdout.write(SHOW + ALT_OFF)
    for (const [sig, fn] of signals) proc.removeListener(sig, fn)
    proc.removeListener('exit', cleanup)
    resolveDone()
  }

  const onKey = data => {
    const s = String(data)
    if (s === 'q' || s === 'Q' || s === '\x03' || s === '\x1b' || s === '\x04') cleanup()
    else if (s === 'r' || s === 'R') refresh()
  }

  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(sig => [sig, () => { cleanup(); proc.exit(130) }])
  for (const [sig, fn] of signals) proc.on(sig, fn)
  proc.on('exit', cleanup)

  stdout.write(ALT_ON + HIDE + `${ESC}2J`)
  try { if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true) } catch {}
  stdin.setEncoding && stdin.setEncoding('utf8')
  stdin.on('data', onKey)
  stdin.resume()
  stdout.on('resize', draw)
  timer = setInterval(refresh, interval)
  clock = setInterval(() => {
    view.tick++
    draw()
  }, 1000)
  refresh()
  return done
}

function snapshot({ stdout = process.stdout, env = process.env } = {}) {
  const { collect } = require('./status')
  const started = Date.now()
  const st = collect()
  const view = { st, scanning: false, lastScanMs: Date.now() - started, interval: defaultInterval(), events: tailEvents(stateDir(), 5) }
  stdout.write(frame(view, { width: stdout.columns || 100, height: Infinity, color: useColor(stdout, env) }).join('\n') + '\n')
}

function main(args, { stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  if (args.includes('--help') || args.includes('-h')) return stdout.write(USAGE + '\n')
  if (args.includes('--once') || !stdout.isTTY || !stdin.isTTY) return snapshot({ stdout, env })
  const sec = Number(option(args, 'interval'))
  const interval = sec >= 0.5 ? sec * 1000 : defaultInterval()
  return live({ stdin, stdout, env, interval }).then(() => process.exit(0))
}

module.exports = { main, frame, layout, live, snapshot, workerScanner, defaultInterval, ALT_ON, ALT_OFF, SHOW }
