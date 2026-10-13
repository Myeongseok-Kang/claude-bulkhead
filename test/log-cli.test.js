'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { spawnSync } = require('child_process')
const { main, parseSince, summarize, renderSummary } = require('../src/log-cli')
const { record } = require('../src/events')
const { tempDir } = require('./helpers')

const now = Date.UTC(2026, 9, 13, 12)
const HOUR = 3600e3

function seed() {
  const dir = tempDir()
  const add = (hoursAgo, guard, rule, project, command, session = 'aaaa1111bbbb') =>
    record(dir, { guard, rule, session, project, command }, { env: {}, now: now - hoursAgo * HOUR })
  add(200, 'kill-guard', 'taskkill-im', '/w/shop', 'taskkill /F /IM node.exe')
  add(30, 'wait-guard', 'poll-loop', '/w/shop', 'until [ -f done ]; do sleep 30; done')
  add(20, 'wait-guard', 'poll-loop', '/w/blog', 'for i in $(seq 1 40); do sleep 15; done', 'cccc2222')
  add(5, 'wait-guard', 'long-sleep', '/w/blog', 'sleep 600', 'cccc2222')
  add(2, 'memory-guard', 'low-memory', '/w/api', 'npx vitest run')
  add(1, 'port-guard', 'kill-by-port', '/w/api', 'npx kill-port 3000')
  return dir
}

function run(args, dir) {
  let out = ''
  let err = ''
  const stdout = { write: s => (out += s), isTTY: false }
  const stderr = { write: s => (err += s) }
  const saved = process.exitCode
  main(args, { env: {}, stdout, stderr, now, dir })
  const code = process.exitCode
  process.exitCode = saved
  return { out, err, code }
}

test('parses --since spans and dates', () => {
  assert.strictEqual(parseSince('24h', now), now - 24 * HOUR)
  assert.strictEqual(parseSince('7d', now), now - 7 * 24 * HOUR)
  assert.strictEqual(parseSince('30m', now), now - 30 * 60e3)
  assert.strictEqual(parseSince('2w', now), now - 14 * 24 * HOUR)
  assert.strictEqual(parseSince('2026-10-01', now), Date.parse('2026-10-01'))
  assert.ok(Number.isNaN(parseSince('yesterday', now)))
})

test('lists recent events, newest last, with -n and filters', () => {
  const dir = seed()
  const all = run([], dir).out.trim().split('\n')
  assert.match(all[0], /^TIME\s+GUARD\s+RULE\s+SESSION\s+PROJECT\s+COMMAND/)
  assert.strictEqual(all.length, 7)
  assert.match(all[6], /port-guard\s+kill-by-port\s+aaaa1111\s+\/w\/api\s+npx kill-port 3000/)
  assert.strictEqual(run(['-n', '2'], dir).out.trim().split('\n').length, 3)
  const waits = run(['--guard', 'wait-guard'], dir).out
  assert.strictEqual((waits.match(/wait-guard/g) || []).length, 3)
  assert.ok(!/kill-guard/.test(run(['--since', '7d'], dir).out))
  const json = JSON.parse(run(['--since=24h', '--json'], dir).out)
  assert.deepStrictEqual(json.map(e => e.rule), ['poll-loop', 'long-sleep', 'low-memory', 'kill-by-port'])
})

test('summary counts per guard and rule, and per project', () => {
  const dir = seed()
  const out = run(['--summary', '--since', '7d'], dir).out
  const lines = out.split('\n')
  assert.match(lines[0], /^5 blocks in the last 7 days, 3 projects, 2 sessions$/)
  assert.match(lines[2], /^GUARD\s+RULE\s+COUNT\s+LAST/)
  assert.match(lines[3], /^wait-guard\s+poll-loop\s+2\s.*█{24}$/)
  assert.match(out, /PROJECT\s+COUNT\n\/w\/blog\s+2\n\/w\/api\s+2\n\/w\/shop\s+1/)
  const sum = JSON.parse(run(['--summary', '--json'], dir).out)
  assert.strictEqual(sum.total, 6)
  assert.deepStrictEqual(sum.rules[0], { guard: 'wait-guard', rule: 'poll-loop', count: 2, last: new Date(now - 20 * HOUR).toISOString() })
  assert.ok(!/\x1b\[/.test(out))
  assert.match(renderSummary(summarize([]), { sinceLabel: '24 hours' }), /no blocks recorded in the last 24 hours/)
})

test('empty log and bad arguments', () => {
  const dir = tempDir()
  assert.match(run([], dir).out, /no blocks recorded yet/)
  const bad = run(['--since', 'soon'], dir)
  assert.strictEqual(bad.code, 1)
  assert.match(bad.err, /cannot read --since soon/)
  // an empty --since (a slash command run without arguments) means all time
  assert.strictEqual(JSON.parse(run(['--summary', '--json', '--since='], seed()).out).total, 6)
})

test('bulkhead log --summary runs end to end', () => {
  const dir = seed()
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'bulkhead'), 'log', '--summary'], {
    encoding: 'utf8', env: { ...process.env, BULKHEAD_STATE_DIR: dir },
  })
  assert.strictEqual(r.status, 0, r.stderr)
  assert.match(r.stdout, /^6 blocks since/)
})
