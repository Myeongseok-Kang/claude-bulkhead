'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { parsePs, parseLsof, readMac } = require('../src/processes')

const ps = [
  '    1     0  12000 Mon Oct  6 08:00:01 2026     /sbin/launchd',
  '  812     1 402000 Mon Oct 13 09:12:01 2026     /Users/dev/.local/bin/claude --resume',
  '  990   812  88000 Mon Oct 13 09:20:44 2026     node /Users/dev/src/acme-web/node_modules/.bin/next dev',
  'garbage line',
].join('\n')

const lsof = ['p990', 'f23', 'n*:3000', 'f24', 'n[::1]:3000', 'p1201', 'f5', 'n127.0.0.1:5173', ''].join('\n')

test('macOS: parses ps output', () => {
  const procs = parsePs(ps, new Map([[990, 'node']]))
  assert.strictEqual(procs.length, 3)
  assert.deepStrictEqual(procs[1], {
    pid: 812, ppid: 1, name: 'claude', cmd: '/Users/dev/.local/bin/claude --resume',
    start: new Date('Mon Oct 13 09:12:01 2026').getTime(), rss: 402000 * 1024, claudePid: null,
  })
  assert.strictEqual(procs[2].name, 'node')
})

test('macOS: parses lsof listening sockets', () => {
  assert.deepStrictEqual(parseLsof(lsof), [{ port: 3000, pid: 990 }, { port: 5173, pid: 1201 }])
})

test('macOS: lsof exiting 1 with no sockets is not an error', () => {
  const run = (file, args) => {
    if (file === 'lsof') throw Object.assign(new Error('exit 1'), { stdout: '' })
    return args[0] === '-axo' ? '  990 node\n' : ps
  }
  const snap = readMac(run)
  assert.strictEqual(snap.procs.length, 3)
  assert.deepStrictEqual(snap.ports, [])
})

test('macOS: CLAUDE_PID from ps -E, only as a whole variable', () => {
  const { parsePsEnv } = require('../src/processes')
  const envOut = [
    '  990 node /Users/dev/src/acme-web/node_modules/.bin/next dev TERM=xterm CLAUDE_PID=812 HOME=/Users/dev',
    ' 1201 vite PATH=/usr/bin CLAUDE_PID=777',
    ' 1300 echo CLAUDE_PID=12x HOME=/Users/dev',
    ' 1400 zsh HOME=/Users/dev',
  ].join('\n')
  assert.deepStrictEqual([...parsePsEnv(envOut)], [[990, 812], [1201, 777]])
  const run = (file, args) => {
    if (file === 'lsof') return lsof
    if (args[0] === '-axo') return '  990 node\n'
    return args[0] === '-axwwE' ? envOut : ps
  }
  const snap = readMac(run, { withEnv: true })
  assert.strictEqual(snap.procs.find(p => p.pid === 990).claudePid, 812)
  assert.strictEqual(snap.procs.find(p => p.pid === 812).claudePid, null)
  // without withEnv no third ps call is made
  assert.strictEqual(readMac((f, a) => { assert.notStrictEqual(a[0], '-axwwE'); return run(f, a) }).procs[2].claudePid, null)
})

test('macOS: a reparented server whose session is gone is an orphan; a live session keeps it', () => {
  const { findOrphans } = require('../src/orphan-reaper')
  const t0 = new Date('Mon Oct 13 09:00:00 2026').getTime()
  const base = [
    { pid: 1, ppid: 0, name: 'launchd', cmd: '/sbin/launchd', start: t0 - 1e7, rss: 0, claudePid: null },
    { pid: 990, ppid: 1, name: 'node', cmd: 'node next dev', start: t0 + 60e3, rss: 0, claudePid: 812 },
  ]
  // session 812 exited: launchd adopted the server
  assert.deepStrictEqual(findOrphans({ procs: base, listening: new Set([990]) }).map(o => o.pid), [990])
  // session 812 still running
  const alive = [...base, { pid: 812, ppid: 1, name: 'claude', cmd: '/Users/dev/.local/bin/claude', start: t0, rss: 0, claudePid: null }]
  assert.deepStrictEqual(findOrphans({ procs: alive, listening: new Set([990]) }), [])
  // no CLAUDE_PID and no Claude shell above it: not ours, left alone
  const foreign = [base[0], { ...base[1], claudePid: null }]
  assert.deepStrictEqual(findOrphans({ procs: foreign, listening: new Set([990]) }), [])
})
