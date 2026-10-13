'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const d = require('../src/doctor')
const config = require('../src/config')
const { record } = require('../src/events')
const { tempDir } = require('./helpers')

const BIN = path.join(__dirname, '..', 'bin', 'bulkhead')

test('node version', () => {
  assert.strictEqual(d.checkNode('20.11.0').status, 'OK')
  assert.strictEqual(d.checkNode('16.20.0').status, 'FAIL')
})

test('plugin root and hooks.json', () => {
  const good = d.checkPlugin()
  assert.strictEqual(good.status, 'OK')
  assert.match(good.summary, /6 PreToolUse/)
  const root = tempDir()
  fs.mkdirSync(path.join(root, 'hooks'))
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ args: ['${CLAUDE_PLUGIN_ROOT}/src/gone.js'] }] }] } }))
  assert.match(d.checkPlugin(root).summary, /missing: src[\\/]gone\.js/)
  assert.strictEqual(d.checkPlugin(tempDir()).status, 'FAIL')
})

test('state dir must be writable', () => {
  assert.strictEqual(d.checkStateDir(tempDir()).status, 'OK')
  const file = path.join(tempDir(), 'file')
  fs.writeFileSync(file, '')
  assert.strictEqual(d.checkStateDir(path.join(file, 'sub')).status, 'FAIL')
})

test('guards say on or off and why', () => {
  const state = tempDir()
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ portGuard: { enabled: false }, basics: { rmRoot: false }, killGuard: { allowNames: ['ffmpeg'] } }))
  const cfg = config.load({ env: { BULKHEAD_STATE_DIR: state, BULKHEAD_DISABLE: 'wait-guard' }, cwd: tempDir() })
  const byId = Object.fromEntries(d.checkGuards(cfg, 'linux').map(c => [c.id, c.summary]))
  assert.strictEqual(byId['wait-guard'], 'off (env BULKHEAD_DISABLE)')
  assert.match(byId['port-guard'], /^off \(.*config\.json\)$/)
  assert.match(byId.basics, /rm-root off/)
  assert.match(byId['kill-guard'], /allowed by name: ffmpeg/)
  assert.strictEqual(d.checkGuards(cfg, 'aix').find(c => c.id === 'orphan-reaper').status, 'WARN')
})

test('broken config files are reported', () => {
  const state = tempDir()
  fs.writeFileSync(path.join(state, 'config.json'), '{"waitGuard": {"limitSeconds": }')
  const checks = d.checkConfig(config.load({ env: { BULKHEAD_STATE_DIR: state }, cwd: tempDir() }))
  assert.strictEqual(checks[0].status, 'WARN')
  assert.match(checks[0].summary, /not valid JSON/)
})

test('process reader: timing, failure and unsupported platforms', () => {
  let t = 0
  const clock = () => (t += 1500)
  const snap = { procs: [{ pid: 1, ppid: 0, name: 'claude', cmd: 'claude', start: 1, rss: 1 }], ports: [] }
  const r = d.checkProcesses({ read: () => snap, files: () => new Map(), now: clock })
  assert.strictEqual(r.status, 'OK')
  assert.match(r.summary, /1 processes, 0 listening ports, 1 Claude session in 1\.5s/)
  assert.strictEqual(d.checkProcesses({ read: () => { throw new Error('spawn powershell.exe ENOENT') } }).status, 'FAIL')
  assert.strictEqual(d.checkProcesses({ read: () => null, platform: 'aix' }).status, 'WARN')
})

test('memory limits for this machine', () => {
  const small = d.checkMemory({ freeGb: 6, totalGb: 16, commitPct: null })
  assert.match(small.summary, /one heavy job at a time/)
  assert.match(small.summary, /below 2\.4 GB/)
  const low = d.checkMemory({ freeGb: 1, totalGb: 32, commitPct: 80 })
  assert.strictEqual(low.status, 'WARN')
  assert.match(low.summary, /commit 80%/)
})

test('event log size, and off', () => {
  const dir = tempDir()
  const on = config.load({ env: { BULKHEAD_STATE_DIR: dir }, cwd: tempDir() })
  assert.match(d.checkLog(on, dir).summary, /empty so far/)
  record(dir, { guard: 'kill-guard', rule: 'pkill' }, { env: {} })
  assert.match(d.checkLog(on, dir).summary, /1 events, \d+ B/)
  const off = config.load({ env: { BULKHEAD_STATE_DIR: dir, BULKHEAD_NO_LOG: '1' }, cwd: tempDir() })
  assert.strictEqual(d.checkLog(off, dir).summary, 'off (env BULKHEAD_NO_LOG)')
})

test('a real hook run blocks', () => {
  const r = d.checkHookRun()
  assert.strictEqual(r.status, 'OK', r.summary)
})

test('exit code 1 on FAIL, and --json', () => {
  const run = checks => {
    let out = ''
    const saved = process.exitCode
    d.main(['--json'], { stdout: { write: s => (out += s) }, env: {}, checks: () => checks })
    const code = process.exitCode
    process.exitCode = saved
    return { json: JSON.parse(out), code }
  }
  const bad = run([{ id: 'node', status: 'FAIL', summary: 'v16' }])
  assert.strictEqual(bad.json.ok, false)
  assert.strictEqual(bad.code, 1)
  const good = run([{ id: 'node', status: 'WARN', summary: 'x' }])
  assert.strictEqual(good.json.ok, true)
  assert.notStrictEqual(good.code, 1)
  assert.match(d.render([{ id: 'node', status: 'OK', summary: 'v20' }, { id: 'git', status: 'WARN', summary: 'missing' }]), /^OK {4}node {2}v20\nWARN {2}git {3}missing\n\n1 OK, 1 WARN, 0 FAIL$/)
})

test('bulkhead doctor runs end to end', () => {
  const r = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, BULKHEAD_STATE_DIR: tempDir(), CLAUDE_CONFIG_DIR: tempDir() },
  })
  const j = JSON.parse(r.stdout)
  assert.ok(j.checks.length >= 15)
  assert.strictEqual(r.status, j.ok ? 0 : 1)
  assert.ok(j.checks.some(c => c.id === 'processes'))
})
