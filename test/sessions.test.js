'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { isClaudeCli, readSessionFiles, findSessions } = require('../src/sessions')
const { tempDir } = require('./helpers')

const MB = 2 ** 20
const t0 = Date.UTC(2026, 9, 13, 8)
const proc = (pid, ppid, name, cmd, start, rss = 0, claudePid = null) => ({ pid, ppid, name, cmd, start, rss, claudePid })
const app = '"C:\\Program Files\\WindowsApps\\Claude_2.1_x64__abc\\app\\Claude.exe"'
const cli = 'C:\\Users\\dev\\AppData\\Roaming\\Claude\\claude-code\\2.1.295\\claude.exe --output-format stream-json'
const shell = ts => `"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/dev/.claude/shell-snapshots/snapshot-bash-${ts}-ab12cd.sh && eval 'npm run dev &'"`

test('tells the CLI apart from the desktop app', () => {
  assert.ok(isClaudeCli(proc(1, 0, 'claude.exe', cli, 0)))
  assert.ok(isClaudeCli(proc(1, 0, 'claude', 'claude --resume', 0)))
  assert.ok(isClaudeCli(proc(1, 0, 'node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', 0)))
  assert.ok(!isClaudeCli(proc(1, 0, 'claude.exe', app, 0)))
  assert.ok(!isClaudeCli(proc(1, 0, 'claude.exe', `${app} --type=renderer`, 0)))
  assert.ok(!isClaudeCli(proc(1, 0, 'Claude', '/Applications/Claude.app/Contents/MacOS/Claude', 0)))
  assert.ok(!isClaudeCli(proc(1, 0, 'node', 'node server.js', 0)))
  // native installer: the process is named after its version
  assert.ok(isClaudeCli(proc(1, 0, '2.1.292', '/home/dev/.local/share/claude/versions/2.1.292 --resume', 0)))
  assert.ok(isClaudeCli(proc(1, 0, '2.1.292', 'claude -p hi', 0)))
  assert.ok(isClaudeCli(proc(1, 0, 'bun', 'bun /w/node_modules/@anthropic-ai/claude-code/cli.js', 0)))
  assert.ok(!isClaudeCli(proc(1, 0, 'claude-helper', 'claude-helper --serve', 0)))
  assert.ok(!isClaudeCli(proc(1, 0, 'bash', 'bash -c "claude -p hi"', 0)))
})

// Claude Code writes the shell snapshot at a session's first Bash call, often minutes after it
// starts, so the snapshot time alone does not say which session started a backgrounded server.
test('windows: a backgrounded server goes to the session that owns its snapshot, or to none', () => {
  const snap = t0 + 10 * 60e3
  const orphanShell = [
    proc(301, 999, 'bash.exe', shell(snap), snap + 60e3, 5 * MB),
    proc(302, 301, 'node.exe', 'node vite', snap + 61e3, 200 * MB),
  ]
  const ports = [{ port: 5173, pid: 302 }]
  const owners = procs => Object.fromEntries(findSessions({ procs, ports }, new Map(), () => null).map(x => [x.pid, x.ports.map(p => p.port)]))
  // only one session, started ten minutes before its first Bash call
  assert.deepStrictEqual(owners([proc(100, 1, 'claude.exe', cli, t0), ...orphanShell]), { 100: [5173] })
  // a second session started just before the snapshot, but it uses a snapshot of its own
  const two = [
    proc(100, 1, 'claude.exe', cli, t0),
    proc(200, 1, 'claude.exe', cli, snap - 60e3),
    proc(201, 200, 'bash.exe', shell(snap - 30e3), snap - 20e3),
    ...orphanShell,
  ]
  assert.deepStrictEqual(owners(two), { 100: [5173], 200: [] })
  // a live shell of session 100 names the same snapshot: that settles it
  assert.deepStrictEqual(owners([...two, proc(110, 100, 'bash.exe', shell(snap), snap + 90e3)]), { 100: [5173], 200: [] })
  // two older sessions and nothing to tell them apart: no owner rather than a guess
  assert.deepStrictEqual(owners([proc(100, 1, 'claude.exe', cli, t0), proc(200, 1, 'claude.exe', cli, snap - 60e3), ...orphanShell]), { 100: [], 200: [] })
})

test('groups process trees, ports and RSS under each session', () => {
  const procs = [
    proc(10, 1, 'claude.exe', app, t0 - 3600e3, 600 * MB),
    proc(100, 10, 'claude.exe', cli, t0, 400 * MB),
    proc(101, 100, 'bash.exe', shell(t0 + 9000), t0 + 60e3, 5 * MB),
    proc(102, 101, 'node.exe', 'node next dev', t0 + 61e3, 300 * MB),
    proc(200, 10, 'claude.exe', cli, t0 + 7200e3, 350 * MB),
    // started with `&`: the wrapper above this shell is gone
    proc(201, 999, 'bash.exe', shell(t0 + 7200e3 + 20000), t0 + 7300e3, 5 * MB),
    proc(202, 201, 'node.exe', 'node vite', t0 + 7301e3, 200 * MB),
    // pid 100 was reused by something newer than this child: not ours
    proc(300, 100, 'node.exe', 'node old.js', t0 - 100, 50 * MB),
    proc(400, 4, 'postgres.exe', 'postgres', t0 - 9e6, 80 * MB),
  ]
  const ports = [{ port: 3000, pid: 102 }, { port: 5173, pid: 202 }, { port: 5432, pid: 400 }]
  const files = new Map([[100, { cwd: 'C:\\work\\shop', startedAt: t0 + 300 }], [200, { cwd: 'C:\\work\\blog', startedAt: t0 - 9e6 }]])
  const sessions = findSessions({ procs, ports }, files, () => null)
  assert.deepStrictEqual(sessions.map(s => s.pid), [100, 200])
  assert.strictEqual(sessions[0].cwd, 'C:\\work\\shop')
  assert.strictEqual(sessions[0].rss, 705 * MB)
  assert.deepStrictEqual(sessions[0].ports, [{ port: 3000, pid: 102, name: 'node.exe' }])
  // the session file's start time does not match pid 200, so its cwd is not trusted
  assert.strictEqual(sessions[1].cwd, null)
  assert.strictEqual(sessions[1].rss, 555 * MB)
  assert.deepStrictEqual(sessions[1].ports.map(p => p.port), [5173])
})

test('linux: CLAUDE_PID claims servers that were reparented to init', () => {
  const procs = [
    proc(1, 0, 'systemd', '/sbin/init', t0 - 9e6),
    proc(50, 1, 'claude', 'claude', t0, 300 * MB),
    proc(60, 1, 'node', 'node next dev', t0 + 1000, 200 * MB, 50),
  ]
  const [s] = findSessions({ procs, ports: [{ port: 3000, pid: 60 }] }, new Map(), pid => `/home/dev/p${pid}`)
  assert.strictEqual(s.cwd, '/home/dev/p50')
  assert.strictEqual(s.rss, 500 * MB)
  assert.deepStrictEqual(s.ports.map(p => p.pid), [60])
})

test('reads session files and skips broken ones', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, '4242.json'), JSON.stringify({ pid: 4242, sessionId: 's1', cwd: '/w/a', startedAt: 5, status: 'idle', extra: 1 }))
  fs.writeFileSync(path.join(dir, '77.json'), '{not json')
  fs.writeFileSync(path.join(dir, '4242.abc.key'), 'x')
  assert.deepStrictEqual([...readSessionFiles(dir)], [[4242, { cwd: '/w/a', startedAt: 5, status: 'idle', sessionId: 's1' }]])
  assert.strictEqual(readSessionFiles(path.join(dir, 'missing')).size, 0)
})
