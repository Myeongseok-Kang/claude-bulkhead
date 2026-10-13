'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { judge } = require('../src/wait-guard')
const { runScript } = require('./helpers')

// [command, tool timeout in ms, should block]
const cases = [
  ['for i in $(seq 1 19); do grep -q DONE out.log && break; sleep 30; done; tail -5 out.log', 600000, true],
  ['for i in $(seq 1 19); do grep -q DONE out || sleep 30; done', 600000, true],
  ['for i in $(seq 1 19); do grep -q DONE out.log && break; sleep 30; done', undefined, false],
  ['until [ -f done.flag ]; do sleep 15; done; cat result.txt', 600000, true],
  ['until curl -s localhost:3000 >/dev/null; do sleep 1; done', undefined, false],
  ['until curl -s localhost:3000 >/dev/null; do sleep 1; done', 300000, true],
  ['sleep 2; tail -20 log.txt', undefined, false],
  ['npm run build 2>&1 | tail -5', 600000, false],
  ['while (-not (Test-Path C:\\work\\done.flag)) { Start-Sleep -Seconds 20 }; Get-Content C:\\work\\r.txt', 600000, true],
  ['Start-Sleep -Milliseconds 500; Get-Content x.log -Tail 5', 600000, false],
  ['for i in 1 2 3; do curl -s http://localhost:4000/health; sleep 2; done', 600000, false],
  ['for i in {1..40}; do grep -q OK r.log && break; sleep 15; done', 600000, true],
  ['grep -n sleep src/app.js | head', 600000, false],
  ["timeout 60 bash -c 'until [ -f x ]; do sleep 5; done'", 600000, false],
  ['for ((i=0; i<10; i++)); do sleep 5; done', 600000, false],
  ['node build.js && sleep 200 && ls', 600000, true],
  ['sleep 5m', 600000, true],
  ['for i in $(seq 1 6); do sleep 20; tail -2 a.log; done', 600000, false],
  ['for i in $(seq 1 30); do sleep 20; tail -2 a.log; done', 600000, true],
  ['1..30 | ForEach-Object { Start-Sleep 20; Get-Content a.log -Tail 2 }', 600000, true],
  ["cat > poll.sh <<'EOF'\n#!/usr/bin/env bash\nwhile true; do sleep 300; done\nEOF\nchmod +x poll.sh", 600000, false],
  ["cat <<'EOF' > w.sh\nuntil [ -f a ]; do sleep 30; done\nEOF", 600000, false],
  // everyday commands that must pass
  ['for i in 1 2 3; do npm test && break; sleep 5; done', 600000, false],
  ['sleep 2 && curl -s localhost:3000/health', 600000, false],
  ['timeout 60 npm test', 600000, false],
  ['Start-Sleep 5; Invoke-WebRequest http://localhost:3000', 600000, false],
  ['for i in $(seq 1 10); do curl -sf localhost:3000 && break; sleep 2; done', 600000, false],
  ['git commit -m "replace the sleep 300 poll loop"', 600000, false],
  ['echo "sleep 600 is too long"', 600000, false],
  ['git commit -m "drop the old poll; sleep 600 was too long"', 600000, false],
  ['node -e "for (const f of files) {}" && sleep 5', 600000, false],
  ['for i in "a" "b"; do sleep 100; done', 600000, true],
  ['grep -rn "sleep 900" scripts/', 600000, false],
  ['sleep 30', 600000, false],
  ["ssh build-box bash -s <<'EOF'\nuntil [ -f a ]; do sleep 30; done\nEOF", 600000, true],
  ["cat > a.sh <<'EOF'\necho hi\nEOF\nuntil [ -f a ]; do sleep 30; done", 600000, true],
  // a trailing & makes a background job; the tool call returns without waiting for it
  ['sleep 600 &', 600000, false],
  ['sleep 600 & echo started', 600000, false],
  ['nohup sleep 900 > /dev/null 2>&1 &', 600000, false],
  ['(sleep 600; touch done.flag) &', 600000, false],
  ['sleep 600 && touch done.flag &', 600000, false],
  ['until [ -f a ]; do sleep 30; done &\necho waiting in the background', 600000, false],
  ['for i in $(seq 1 30); do sleep 20; tail -2 a.log; done & disown', 600000, false],
  ['npm run dev > dev.log 2>&1 & sleep 5; curl -s localhost:3000', 600000, false],
  // ...but not when the foreground still waits
  ['sleep 600 & wait', 600000, true],
  ['sleep 600 &\nwait $!', 600000, true],
  ['npm run dev > dev.log 2>&1 & sleep 300; curl -s localhost:3000', 600000, true],
  ['sleep 600 2>&1', 600000, true],
  ['sleep 600 &>/dev/null', 600000, true],
  ['sleep 600 && echo done', 600000, true],
  ['curl "http://x/?a=1&b=2"; sleep 600', 600000, true],
  ['until [ -f a ]; do sleep 30 & done', 600000, true],
]

test('estimates worst-case foreground waits', () => {
  for (const [cmd, timeout, want] of cases) {
    assert.strictEqual(!!judge(cmd, timeout), want, `${want ? 'block' : 'allow'} t=${timeout}: ${cmd}`)
  }
})

test('limit is configurable', () => {
  assert.ok(!judge('sleep 200', 600000, 300))
  assert.ok(judge('sleep 200', 600000, 60))
})

test('hook blocks foreground loops and lets background runs through', () => {
  const loop = 'until [ -f done.flag ]; do sleep 15; done'
  const fg = runScript('wait-guard', { tool_name: 'Bash', tool_input: { command: loop, timeout: 600000 } })
  assert.strictEqual(fg.status, 2)
  assert.match(fg.stderr, /run_in_background/)
  const bg = runScript('wait-guard', { tool_name: 'Bash', tool_input: { command: loop, timeout: 600000, run_in_background: true } })
  assert.strictEqual(bg.status, 0)
  const env = runScript('wait-guard', { tool_input: { command: 'sleep 200', timeout: 600000 } }, { BULKHEAD_WAIT_MAX_SEC: '300' })
  assert.strictEqual(env.status, 0)
  assert.strictEqual(runScript('wait-guard', 'not json').status, 0)
})
