'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { record, readEvents, tailEvents, logSize, eventsFile, truncate } = require('../src/events')
const { runScript, tempDir } = require('./helpers')

const env = {}

test('appends one JSON line per event with the fields people filter on', () => {
  const dir = tempDir()
  const now = Date.UTC(2026, 9, 13, 9, 30)
  assert.strictEqual(record(dir, { guard: 'kill-guard', rule: 'taskkill-im', session: 's1', project: '/w/shop', command: 'taskkill /F /IM node.exe' }, { env, now }), true)
  const lines = fs.readFileSync(eventsFile(dir), 'utf8').trim().split('\n')
  assert.strictEqual(lines.length, 1)
  assert.deepStrictEqual(JSON.parse(lines[0]), {
    time: '2026-10-13T09:30:00.000Z', guard: 'kill-guard', rule: 'taskkill-im', session: 's1', project: '/w/shop', command: 'taskkill /F /IM node.exe',
  })
})

test('commands are cut to 200 characters on one line', () => {
  const dir = tempDir()
  record(dir, { guard: 'wait-guard', rule: 'poll-loop', command: 'x'.repeat(500) + '\n' + 'y' }, { env })
  const e = readEvents(dir)[0]
  assert.strictEqual(e.command.length, 200)
  assert.ok(e.command.endsWith('…'))
  assert.strictEqual(truncate('a\n  b'), 'a b')
})

test('rotates at the size limit and keeps one old file', () => {
  const dir = tempDir()
  const big = 'c'.repeat(150)
  for (let i = 0; i < 40; i++) record(dir, { guard: 'wait-guard', rule: 'r', command: `${i} ${big}` }, { env, now: 1e12 + i, maxBytes: 2000 })
  assert.ok(fs.existsSync(eventsFile(dir) + '.1'))
  assert.ok(fs.statSync(eventsFile(dir)).size <= 2000)
  assert.ok(fs.statSync(eventsFile(dir) + '.1').size <= 2000)
  assert.ok(!fs.existsSync(eventsFile(dir) + '.2'))
  const all = readEvents(dir)
  assert.strictEqual(all[all.length - 1].command.split(' ')[0], '39')
  // oldest first across both files
  const nums = all.map(e => Number(e.command.split(' ')[0]))
  assert.deepStrictEqual(nums, [...nums].sort((a, b) => a - b))
  assert.strictEqual(logSize(dir).files, 2)
})

test('BULKHEAD_NO_LOG turns it off and a bad directory never throws', () => {
  const dir = tempDir()
  assert.strictEqual(record(dir, { guard: 'basics', rule: 'rm-root' }, { env: { BULKHEAD_NO_LOG: '1' } }), false)
  assert.ok(!fs.existsSync(eventsFile(dir)))
  const file = path.join(tempDir(), 'not-a-dir')
  fs.writeFileSync(file, '')
  assert.strictEqual(record(path.join(file, 'sub'), { guard: 'basics', rule: 'rm-root' }, { env }), false)
})

test('reading skips corrupt lines and tails the last events', () => {
  const dir = tempDir()
  for (let i = 0; i < 8; i++) record(dir, { guard: 'kill-guard', rule: 'pkill', command: String(i) }, { env, now: 1e12 + i * 1000 })
  fs.appendFileSync(eventsFile(dir), '{not json\n\n{"no":"guard"}\n')
  assert.strictEqual(readEvents(dir).length, 8)
  assert.deepStrictEqual(tailEvents(dir, 3).map(e => e.command), ['5', '6', '7'])
  assert.deepStrictEqual(tailEvents(tempDir(), 3), [])
})

// Each guard records its block when run as a hook.
const blocks = [
  ['kill-guard', 'taskkill /F /IM node.exe', 'taskkill-im'],
  ['wait-guard', 'for i in $(seq 1 30); do sleep 20; done', 'poll-loop', { timeout: 600000 }],
  ['memory-guard', 'echo x > ~/.claude/bulkhead/slots/slot-1.json', 'slot-files'],
  ['basics', 'rm -rf /', 'rm-root'],
]

for (const [guard, command, rule, extra] of blocks) {
  test(`${guard} writes an event when it blocks`, () => {
    const dir = tempDir()
    const r = runScript(guard, { session_id: 'abc', cwd: '/w/shop', tool_input: { command, ...extra } }, { BULKHEAD_STATE_DIR: dir, CLAUDE_PROJECT_DIR: '' })
    assert.strictEqual(r.status, 2, r.stderr)
    const [e] = readEvents(dir)
    assert.strictEqual(e.guard, guard)
    assert.strictEqual(e.rule, rule)
    assert.strictEqual(e.session, 'abc')
    assert.strictEqual(e.project, '/w/shop')
    assert.ok(command.startsWith(e.command.slice(0, 20)))
    assert.match(fs.readFileSync(path.join(dir, 'guards.log'), 'utf8'), new RegExp(`${guard} blocked ${rule}:`))
  })
}

test('CLAUDE_PROJECT_DIR wins over the tool cwd, and nothing is written when the call passes', () => {
  const dir = tempDir()
  runScript('kill-guard', { cwd: '/w/shop/sub', tool_input: { command: 'pkill node' } }, { BULKHEAD_STATE_DIR: dir, CLAUDE_PROJECT_DIR: '/w/shop' })
  assert.strictEqual(readEvents(dir)[0].project, '/w/shop')
  const quiet = tempDir()
  assert.strictEqual(runScript('kill-guard', { tool_input: { command: 'taskkill /PID 42 /F' } }, { BULKHEAD_STATE_DIR: quiet }).status, 0)
  assert.ok(!fs.existsSync(eventsFile(quiet)))
})

test('rule names for checkout-guard, basics and orphan-reaper', () => {
  assert.strictEqual(require('../src/checkout-guard').ruleOf('ls && git stash pop'), 'git-stash')
  assert.strictEqual(require('../src/checkout-guard').ruleOf('git switch -c x'), 'git-switch')
  const { ruleOf } = require('../src/basics')
  assert.strictEqual(ruleOf('[bulkhead] basics: force-pushing to main'), 'force-push-main')
  assert.strictEqual(ruleOf('[bulkhead] basics: `git reset --hard` would throw away 2 uncommitted changes'), 'discard-changes')
  assert.strictEqual(ruleOf('[bulkhead] basics: `rm -rf ~` deletes your home directory'), 'rm-root')
  const { findOrphans } = require('../src/orphan-reaper')
  const procs = [{ pid: 50, ppid: 1, name: 'node', cmd: 'node server.js', start: 1e12, rss: 0, claudePid: 7 }]
  assert.strictEqual(findOrphans({ procs, listening: new Set([50]) })[0].owner, 7)
})

test('a block still happens when logging is off', () => {
  const dir = tempDir()
  const r = runScript('kill-guard', { tool_input: { command: 'pkill node' } }, { BULKHEAD_STATE_DIR: dir, BULKHEAD_NO_LOG: '1' })
  assert.strictEqual(r.status, 2)
  assert.ok(!fs.existsSync(eventsFile(dir)))
})
