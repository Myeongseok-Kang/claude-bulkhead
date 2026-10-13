#!/usr/bin/env node
'use strict'
// Measures how long each PreToolUse guard takes per tool call, the way Claude Code runs it:
// a fresh node process with the hook payload on stdin. Prints the median of N runs.
//   node scripts/bench-hooks.js [runs]
// "pass" is an everyday command the guard lets through. "block" is one it stops; it is timed
// with the event log on and off, so the difference is what logging costs.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const runs = Number(process.argv[2]) || 15
const src = path.join(__dirname, '..', 'src')

const cases = [
  ['kill-guard', 'ls -la', 'pkill node'],
  ['wait-guard', 'sleep 2 && curl -s localhost:3000', 'sleep 600'],
  ['memory-guard', 'ls -la', 'echo x > ~/.claude/bulkhead/slots/slot-1.json'],
  ['port-guard', 'ls -la', null],
  ['checkout-guard', 'git status', null],
  ['basics', 'ls -la', 'rm -rf /'],
]

function time(file, command, env) {
  const input = JSON.stringify({ session_id: 'bench', cwd: process.cwd(), tool_name: 'Bash', tool_input: { command, timeout: 600000 } })
  const out = []
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint()
    spawnSync(process.execPath, [file], { input, env })
    out.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  out.sort((a, b) => a - b)
  return out[Math.floor(out.length / 2)]
}

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'bulkhead-bench-'))
const base = { ...process.env, BULKHEAD_STATE_DIR: state, CLAUDE_PROJECT_DIR: state, BULKHEAD_DISABLE: '' }
const empty = path.join(state, 'empty.js')
fs.writeFileSync(empty, '')
const ms = n => (n == null ? '-' : `${n.toFixed(1)} ms`)

console.log(`${os.platform()} ${os.release()}, node ${process.version}, median of ${runs} runs`)
console.log(`node startup alone: ${ms(time(empty, 'ls', base))}`)
console.log('')
console.log('GUARD           PASS       BLOCK+LOG  BLOCK NO-LOG')
for (const [name, pass, block] of cases) {
  const file = path.join(src, `${name}.js`)
  const p = time(file, pass, base)
  const b = block ? time(file, block, base) : null
  const n = block ? time(file, block, { ...base, BULKHEAD_NO_LOG: '1' }) : null
  console.log(`${name.padEnd(16)}${ms(p).padEnd(11)}${ms(b).padEnd(11)}${ms(n)}`)
}
const lines = fs.existsSync(path.join(state, 'events.jsonl')) ? fs.readFileSync(path.join(state, 'events.jsonl'), 'utf8').trim().split('\n').length : 0
console.log(`\nevents written: ${lines}`)
fs.rmSync(state, { recursive: true, force: true })
