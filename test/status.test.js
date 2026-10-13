'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { spawnSync } = require('child_process')
const { collect, render, toJson, size } = require('../src/status')
const { tempDir } = require('./helpers')

process.env.BULKHEAD_STATE_DIR = tempDir()

const MB = 2 ** 20
const now = new Date(2026, 9, 13, 14, 30).getTime()
const snapshot = {
  procs: [
    { pid: 812, ppid: 1, name: 'claude', cmd: 'claude', start: new Date(2026, 9, 12, 22, 5).getTime(), rss: 400 * MB, claudePid: null },
    { pid: 990, ppid: 812, name: 'node', cmd: 'node next dev', start: new Date(2026, 9, 13, 9, 0).getTime(), rss: 1200 * MB, claudePid: 812 },
    { pid: 1001, ppid: 1, name: 'claude', cmd: 'claude', start: new Date(2026, 9, 13, 11, 40).getTime(), rss: 300 * MB, claudePid: null },
  ],
  ports: [{ port: 3000, pid: 990 }, { port: 9229, pid: 990 }],
}
const files = new Map([[812, { cwd: '/home/dev/src/acme-web', startedAt: 0 }]])
const slots = [{ file: '/s/slot-1.json', label: 'npx playwright test', gb: 4, pid: 4321, at: now - 12 * 60e3 }]
const mem = { freeGb: 9.14, totalGb: 31.8, commitPct: null }

test('renders sessions, their ports, slots and free RAM', () => {
  const st = collect({ snapshot, files, slots, mem, now })
  assert.strictEqual(render(st, { home: '/home/dev' }), [
    'SESSION  STARTED       RSS     PROJECT',
    '812      Oct 12 22:05  1.6 GB  ~/src/acme-web',
    '  :3000  node  pid 990',
    '  :9229  node  pid 990',
    '1001     11:40         300 MB  ?',
    '',
    'SLOT    GB  PID   AGE     COMMAND',
    'slot-1  4   4321  12 min  npx playwright test',
    '',
    '9.1 GB free of 31.8 GB',
  ].join('\n'))
})

test('says so when nothing is running', () => {
  const st = collect({ snapshot: null, files, slots: [], mem: { ...mem, commitPct: 61 }, now })
  assert.strictEqual(render(st), 'no Claude sessions found\n\nno heavy jobs in bulkhead-slot\n\n9.1 GB free of 31.8 GB, commit 61%')
})

test('bold headers only when asked', () => {
  const st = collect({ snapshot, files, slots, mem, now })
  assert.ok(!render(st).includes('\x1b['))
  assert.ok(render(st, { color: true }).startsWith('\x1b[1mSESSION'))
})

test('json keeps raw numbers and ISO times', () => {
  const j = toJson(collect({ snapshot, files, slots, mem, now }))
  assert.strictEqual(j.sessions[0].rss, 1600 * MB)
  assert.strictEqual(j.sessions[0].start, new Date(2026, 9, 12, 22, 5).toISOString())
  assert.deepStrictEqual(j.sessions[0].ports[0], { port: 3000, pid: 990, name: 'node' })
  assert.strictEqual(j.slots[0].slot, 'slot-1')
})

test('sizes', () => {
  assert.strictEqual(size(512 * MB), '512 MB')
  assert.strictEqual(size(1.25 * 2 ** 30), '1.3 GB')
})

test('bulkhead status --json runs end to end', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'bulkhead'), 'status', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, BULKHEAD_STATE_DIR: tempDir(), CLAUDE_CONFIG_DIR: tempDir(), BULKHEAD_TEST_MEMORY: JSON.stringify(mem) },
  })
  assert.strictEqual(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.ok(Array.isArray(j.sessions))
  assert.deepStrictEqual(j.slots, [])
  assert.strictEqual(j.memory.freeGb, 9.14)
})
