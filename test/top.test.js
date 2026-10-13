'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { EventEmitter } = require('events')
const { spawnSync } = require('child_process')
const { frame, layout, live, workerScanner, ALT_ON, ALT_OFF, SHOW } = require('../src/top')
const { tempDir } = require('./helpers')

const MB = 2 ** 20
const now = new Date(2026, 9, 13, 14, 30, 5).getTime()
const st = {
  at: now,
  sessions: [
    { pid: 18672, start: new Date(2026, 9, 12, 17, 49).getTime(), cwd: '/home/dev/src/acme-web', rss: 1400 * MB, children: 12, ports: [{ port: 3000, pid: 1, name: 'node' }, { port: 24678, pid: 1, name: 'node' }] },
    { pid: 21888, start: new Date(2026, 9, 13, 9, 52).getTime(), cwd: '/home/dev/src/a-very-long-project-name-that-will-not-fit', rss: 353 * MB, children: 3, ports: [] },
  ],
  slots: [{ slot: 'slot-1', label: 'npx playwright test', gb: 4, pid: 30112, at: now - 6 * 60e3 }],
  queue: [{ label: 'npm run build', gb: 3, pid: 30200, at: now - 2 * 60e3, reason: 'this machine has 16 GB; one heavy job at a time' }],
  memory: { freeGb: 9.9, totalGb: 31.8, commitPct: 68 },
}
const events = [{ time: new Date(now - 60e3).toISOString(), guard: 'kill-guard', rule: 'taskkill-im', project: '/home/dev/src/acme-web', command: 'taskkill /F /IM node.exe' }]
const view = { st, scanning: false, lastScanMs: 1400, interval: 4000, events, now }
const visible = s => s.replace(/\x1b\[[0-9;]*m/g, '')

test('renders every section at a normal width', () => {
  const lines = frame(view, { width: 110, height: 40, home: '/home/dev' })
  const text = lines.join('\n')
  assert.match(lines[0], /^bulkhead top {2}14:30:05 +scan 1\.4s {2}every 4s {2}q quit {2}r refresh$/)
  assert.match(lines[1], /^RAM █+░+ {2}9\.9 GB free of 31\.8 GB {2}commit 68%$/)
  assert.match(text, /SESSIONS 2\nPID +STARTED +PROJECT +RSS +PROCS +PORTS/)
  assert.match(text, /18672 +Oct 12 17:49 +~\/src\/acme-web +1\.4 GB +█{10} +12 +:3000 :24678/)
  assert.match(text, /HEAVY JOBS {2}1 running, 1 waiting\nslot-1 +4 GB +30112 +6 min +npx playwright test\nwait #1 3 GB +30200 +2 min +npm run build {2}\(this machine/)
  assert.match(text, /RECENT BLOCKS\n\d\d:\d\d {2}kill-guard +taskkill-im +~\/src\/acme-web +taskkill \/F \/IM node\.exe/)
  for (const l of lines) assert.ok(l.length <= 110, `too wide: ${l}`)
})

test('narrow terminals drop columns and truncate, never wrap', () => {
  for (const width of [80, 60, 40, 24, 10]) {
    const lines = frame(view, { width, height: 40, home: '/home/dev', color: true })
    for (const l of lines) assert.ok(visible(l).length <= Math.max(24, width), `width ${width}: ${visible(l)}`)
  }
  assert.deepStrictEqual(layout(60).map(c => c.key), ['pid', 'started', 'project', 'rss', 'procs', 'ports'])
  assert.deepStrictEqual(layout(45).map(c => c.key), ['pid', 'project', 'rss', 'procs', 'ports'])
  assert.deepStrictEqual(layout(30).map(c => c.key), ['pid', 'project', 'rss'])
  assert.ok(frame(view, { width: 60, home: '/home/dev' }).join('\n').includes('…'))
})

test('short terminals cut the session list with a count', () => {
  const many = { ...view, st: { ...st, sessions: Array.from({ length: 30 }, (_, i) => ({ ...st.sessions[1], pid: 1000 + i })) } }
  const lines = frame(many, { width: 100, height: 24, home: '/home/dev' })
  assert.ok(lines.length <= 24)
  assert.ok(lines.some(l => /^\.\.\. \d+ more$/.test(l)))
})

test('colors only when asked; first frame shows the scan state', () => {
  assert.ok(!frame(view, { width: 100 }).join('').includes('\x1b['))
  assert.ok(frame(view, { width: 100, color: true }).join('').includes('\x1b[32m'))
  const first = frame({ st: null, scanning: true, interval: 2000, tick: 1, now }, { width: 100 })
  assert.match(first[0], /scanning \//)
  assert.strictEqual(first[2], 'reading processes...')
  const low = frame({ ...view, st: { ...st, memory: { freeGb: 1.2, totalGb: 31.8, commitPct: null, swapTotalGb: 2, swapUsedGb: 0.5 } } }, { width: 100 })
  assert.match(low[1], /swap 0\.5\/2\.0 GB/)
  assert.match(low[2], /memory-guard is blocking heavy commands/)
})

function fakeTerminal() {
  const stdin = new EventEmitter()
  Object.assign(stdin, { isTTY: true, raw: false, setRawMode(v) { this.raw = v }, resume() { this.paused = false }, pause() { this.paused = true }, setEncoding() {} })
  const stdout = new EventEmitter()
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 30, out: '', write(s) { this.out += s } })
  const proc = new EventEmitter()
  proc.exit = () => {}
  return { stdin, stdout, proc }
}

test('live view: scans in the background, refreshes on r, redraws on resize, restores the terminal on q', async () => {
  const { stdin, stdout, proc } = fakeTerminal()
  let scans = 0
  let closed = false
  let release
  const scanner = {
    scan: () => { scans++; return new Promise(r => (release = () => r({ st, ms: 900 }))) },
    close: () => { closed = true },
  }
  const done = live({ stdin, stdout, env: {}, interval: 60000, scanner, events: () => events, proc })
  assert.ok(stdout.out.startsWith(ALT_ON))
  assert.strictEqual(stdin.raw, true)
  assert.match(stdout.out, /scanning/)
  assert.strictEqual(scans, 1)
  stdin.emit('data', 'r') // a refresh while scanning waits for the scan in flight
  assert.strictEqual(scans, 1)
  release()
  await new Promise(r => setImmediate(r))
  assert.match(stdout.out, /scan 0\.9s/)
  assert.match(stdout.out, /18672/)
  assert.strictEqual(scans, 2)
  release()
  await new Promise(r => setImmediate(r))
  stdout.columns = 40
  stdout.out = ''
  stdout.emit('resize')
  assert.ok(stdout.out.length > 0)
  stdin.emit('data', 'q')
  await done
  assert.ok(stdout.out.endsWith(SHOW + ALT_OFF))
  assert.strictEqual(stdin.raw, false)
  assert.ok(closed)
  assert.strictEqual(proc.listenerCount('SIGINT'), 0)
})

test('Ctrl-C quits cleanly too, and a failed scan is shown', async () => {
  const { stdin, stdout, proc } = fakeTerminal()
  const scanner = { scan: () => Promise.reject(new Error('powershell.exe not found')), close() {} }
  const done = live({ stdin, stdout, env: {}, interval: 60000, scanner, events: () => [], proc })
  await new Promise(r => setImmediate(r))
  assert.match(stdout.out, /scan failed: powershell\.exe not found/)
  stdin.emit('data', '\x03')
  await done
  assert.ok(stdout.out.endsWith(SHOW + ALT_OFF))
})

test('the worker scanner returns real status data', async () => {
  const scanner = workerScanner()
  try {
    const msg = await scanner.scan()
    assert.ok(Array.isArray(msg.st.sessions))
    assert.ok(msg.st.memory.totalGb > 0)
    assert.ok(msg.ms >= 0)
  } finally {
    scanner.close()
  }
})

test('without a terminal it prints one snapshot and exits', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'bulkhead'), 'top'], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, BULKHEAD_STATE_DIR: tempDir(), CLAUDE_CONFIG_DIR: tempDir(), BULKHEAD_TEST_MEMORY: JSON.stringify(st.memory) },
  })
  assert.strictEqual(r.status, 0, r.stderr)
  assert.match(r.stdout, /^bulkhead top/)
  assert.match(r.stdout, /HEAVY JOBS/)
  assert.ok(!r.stdout.includes('\x1b['))
})
