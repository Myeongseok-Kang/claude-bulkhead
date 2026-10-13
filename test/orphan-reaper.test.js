'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const reaper = require('../src/orphan-reaper')
const { findOrphans, descendants, ruleFor, keeper, snapshotPath, snapshotExists, sessionOf, onSessionEnd, RULES } = reaper
const { parseWindows, parseProcStat, parseNetTcp, readLinux, envValue } = require('../src/processes')
const { tempDir } = require('./helpers')

const H = 3600e3
const now = Date.UTC(2026, 9, 13, 12)
const bashCmd = ts => `"C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe" -c "source /c/Users/dev/.claude/shell-snapshots/snapshot-bash-${ts}-ab12cd.sh 2>/dev/null || true && eval 'npm run dev'"`
const psCmd = '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; Invoke-Expression -Command $__claudeCodeScript"'
const proc = (pid, ppid, name, cmd, start, claudePid = null) => ({ pid, ppid, name, cmd, start, claudePid })
// snapshot files that still exist; every other one counts as removed by its exited session
const existing = (...ts) => file => ts.some(t => String(file).includes(String(t)))
const win = (extra = {}) => ({ platform: 'win32', snapshotExists: existing(), ...extra })
const pairs = found => found.map(o => [o.pid, o.top]).sort((a, b) => a[0] - b[0])

test('windows: stops servers whose session died and leaves everything else', () => {
  const t0 = now - 2 * H
  const procs = [
    proc(100, 4, 'claude.exe', 'claude.exe', t0),
    // live session
    proc(200, 100, 'bash.exe', bashCmd(t0 + 15000), t0 + 20000),
    proc(201, 200, 'node.exe', 'node next dev', t0 + 21000),
    // dead session: parent 999 no longer exists
    proc(300, 999, 'bash.exe', bashCmd(now - 30 * H), now - 30 * H),
    proc(301, 300, 'node.exe', 'node vite', now - 30 * H),
    proc(302, 300, 'java.exe', 'java -jar gradle-daemon.jar', now - 30 * H),
    proc(303, 300, 'chrome.exe', 'chrome.exe --headless=new --remote-debugging-port=9222', now - 30 * H),
    proc(304, 303, 'chrome.exe', 'chrome.exe --type=renderer --headless=new', now - 30 * H),
    // started by the user, not by Claude
    proc(400, 998, 'node.exe', 'node server.js', now - 40 * H),
    // live session that backgrounded a server with & and whose shell wrapper already exited
    proc(500, 997, 'bash.exe', bashCmd(t0 + 12000), t0 + 30000),
    proc(501, 500, 'node.exe', 'node api.js', t0 + 31000),
    // PID 700 was reused by a newer claude; shell 600 belonged to an older one
    proc(700, 4, 'claude.exe', 'claude.exe', now - 1 * H),
    proc(600, 700, 'bash.exe', bashCmd(now - 20 * H), now - 20 * H),
    proc(601, 600, 'python.exe', 'python -m http.server', now - 20 * H),
    // PowerShell tool shells have no snapshot timestamp: only old ones are touched
    proc(800, 996, 'powershell.exe', psCmd, now - 1 * H),
    proc(801, 800, 'node.exe', 'node serve.js', now - 1 * H),
    proc(810, 995, 'powershell.exe', psCmd, now - 9 * H),
    proc(811, 810, 'node.exe', 'node serve.js', now - 9 * H),
  ]
  const listening = new Set([201, 301, 302, 400, 501, 601, 801, 811])
  const found = findOrphans({ procs, listening }, now, win({ snapshotExists: existing(t0 + 12000, t0 + 15000) }))
  assert.deepStrictEqual(pairs(found), [[301, 300], [601, 600], [811, 810]])
  assert.strictEqual(found.find(o => o.pid === 811).rule, 'dev-server')
})

test('windows: a headless browser alone under a dead shell is stopped', () => {
  const procs = [
    proc(300, 999, 'bash.exe', bashCmd(now - 30 * H), now - 30 * H),
    proc(303, 300, 'chrome.exe', 'chrome.exe --headless=new', now - 30 * H),
    proc(304, 303, 'chrome.exe', 'chrome.exe --type=renderer', now - 30 * H),
  ]
  const found = findOrphans({ procs, listening: new Set() }, now, win())
  assert.deepStrictEqual(found.map(o => [o.pid, o.rule]), [[303, 'headless-browser']])
})

// Each candidate sits under its own dead tool shell, so every rule is checked on its own.
test('windows: every rule in the table, each under a dead shell', () => {
  const t = now - 3 * H
  const procs = [proc(100, 4, 'claude.exe', 'claude.exe', now - H)]
  const expect = {}
  let pid = 1000
  const add = (name, cmd, rule, { listening = false } = {}) => {
    const shell = pid++
    procs.push(proc(shell, 90000 + shell, 'bash.exe', bashCmd(t - 60000), t))
    const p = pid++
    procs.push(proc(p, shell, name, cmd, t + 1000))
    if (rule) expect[p] = rule
    if (listening) listen.add(p)
    return p
  }
  const listen = new Set()
  const nm = 'C:\\w\\app\\node_modules'
  add('node.exe', `node ${nm}\\vitest\\dist\\workers\\forks.js`, 'test-runner')
  add('node.exe', `node ${nm}\\.pnpm\\tinypool@1.0.0\\node_modules\\tinypool\\dist\\entry\\process.js`, 'test-runner')
  add('node.exe', `node ${nm}\\jest-worker\\build\\workers\\processChild.js`, 'test-runner')
  add('node.exe', `node ${nm}\\mocha\\lib\\nodejs\\worker.js`, 'test-runner')
  add('node.exe', `node ${nm}\\ava\\lib\\worker\\base.js`, 'test-runner')
  add('node.exe', '"C:\\Program Files\\nodejs\\node.exe" --test test/', 'test-runner')
  add('bun.exe', 'bun test --watch', 'test-runner')
  add('deno.exe', 'deno test -A', 'test-runner')
  add('node.exe', `node ${nm}\\@playwright\\test\\cli.js test --workers=4`, 'test-runner')
  add('node.exe', `node ${nm}\\playwright\\lib\\common\\process.js`, 'test-runner')
  add('python.exe', 'C:\\py\\python.exe -m pytest -n 8', 'test-runner')
  add('pytest.exe', 'C:\\w\\.venv\\Scripts\\pytest.exe tests', 'test-runner')
  add('python.exe', 'C:\\py\\python.exe -c "import sys;exec(eval(sys.stdin.readline()))"', 'test-runner')
  add('cargo.exe', 'cargo test --workspace', 'test-runner')
  add('app-0123456789abcdef.exe', 'C:\\w\\r\\target\\debug\\deps\\app-0123456789abcdef.exe --test-threads=4', 'test-runner')
  add('go.exe', '"C:\\Program Files\\Go\\bin\\go.exe" test ./...', 'test-runner')
  add('pkg.test.exe', 'C:\\Users\\dev\\AppData\\Local\\Temp\\go-build123\\b001\\pkg.test.exe -test.v', 'test-runner')
  add('dotnet.exe', 'dotnet test App.sln', 'test-runner')
  add('testhost.exe', 'C:\\w\\bin\\testhost.exe --port 5000', 'test-runner')
  add('node.exe', `node ${nm}\\typescript\\bin\\tsc --watch -p .`, 'watcher')
  add('node.exe', `node ${nm}\\vite\\bin\\vite.js build --watch`, 'watcher')
  add('esbuild.exe', `${nm}\\@esbuild\\win32-x64\\esbuild.exe src/a.ts --bundle --watch`, 'watcher')
  add('node.exe', `node ${nm}\\rollup\\dist\\bin\\rollup -c -w`, 'watcher')
  add('node.exe', `node ${nm}\\nodemon\\bin\\nodemon.js server.js`, 'watcher')
  add('node.exe', 'node --watch server.js', 'watcher')
  add('node.exe', `node ${nm}\\tsx\\dist\\cli.mjs watch src/index.ts`, 'watcher')
  add('node.exe', `node ${nm}\\next\\dist\\bin\\next build`, 'builder')
  add('turbo.exe', 'turbo.exe run build --filter=web', 'builder')
  add('node.exe', `node ${nm}\\webpack\\bin\\webpack.js --mode production`, 'builder')
  add('node.exe', `node ${nm}\\typescript\\bin\\tsc -b`, 'builder')
  add('chrome.exe', 'chrome.exe --remote-debugging-pipe --user-data-dir=C:\\T\\playwright_chromiumdev_profile-abc', 'headless-browser')
  add('firefox.exe', 'firefox.exe -no-remote -headless -profile C:\\T\\playwright_firefoxdev_profile-x -juggler-pipe', 'headless-browser')
  add('msedge.exe', 'msedge.exe --headless --disable-gpu', 'headless-browser')
  add('redis-server.exe', 'redis-server.exe --port 6390', 'dev-server', { listening: true })
  add('myworker.exe', 'myworker.exe --queue jobs', 'extra-name')
  // not stopped: nothing heavy, a shared daemon, the user's own Chrome, a shell that only names vitest
  add('node.exe', 'node scripts/print.js')
  add('turbo.exe', 'turbo.exe daemon', null, { listening: true })
  add('java.exe', 'java -cp gradle.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10', null, { listening: true })
  add('adb.exe', 'adb.exe -L tcp:5037 fork-server server', null, { listening: true })
  add('chrome.exe', 'chrome.exe --remote-debugging-port=9222 https://example.com')
  add('bash.exe', 'bash -c "sleep 999; npx vitest"')
  const found = findOrphans({ procs, listening: listen }, now, win({ extraNames: ['myworker.exe'] }))
  const got = Object.fromEntries(found.map(o => [o.pid, o.rule]))
  assert.deepStrictEqual(got, expect)
  for (const o of found) assert.ok(o.what && o.why, `${o.pid} has a reason`)
})

test('windows: editors, terminals and their children are left alone', () => {
  const t = now - 30 * H
  const procs = [
    proc(300, 999, 'bash.exe', bashCmd(t), t),
    // `code .` from the tool shell, and a dev server the user started in its terminal
    proc(310, 300, 'Code.exe', '"C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" .', t + 1000),
    proc(311, 310, 'bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe --login -i', t + 2000),
    proc(312, 311, 'node.exe', 'node C:\\w\\node_modules\\vitest\\vitest.mjs', t + 3000),
    proc(320, 300, 'WindowsTerminal.exe', 'wt.exe', t + 1000),
    proc(321, 320, 'node.exe', 'node server.js', t + 2000),
    // a vite server in the same orphaned shell is stopped, but not the editor next to it
    proc(330, 300, 'node.exe', 'node C:\\w\\node_modules\\vite\\bin\\vite.js', t + 1000),
    proc(331, 330, 'esbuild.exe', 'esbuild.exe --service=0.21.5 --ping', t + 1500),
    // older than its "parent": PID 330 was reused, so this is not part of the tree
    proc(332, 330, 'node.exe', 'node unrelated.js', t - 5000),
    // a user terminal outside Claude: no tool shell in the chain
    proc(400, 998, 'bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe --login -i', t),
    proc(401, 400, 'node.exe', 'node C:\\w\\node_modules\\vitest\\dist\\workers\\forks.js', t),
  ]
  const found = findOrphans({ procs, listening: new Set([310, 321, 330]) }, now, win())
  assert.deepStrictEqual(pairs(found), [[330, 300]])
  assert.deepStrictEqual(descendants(300, procs, keeper()), [300, 330, 331])
  assert.deepStrictEqual(descendants(300, procs, keeper(['esbuild'])), [300, 330])
  assert.deepStrictEqual(findOrphans({ procs, listening: new Set([330]) }, now, win({ keepNames: ['node.exe'] })), [])
})

test('windows: the shell snapshot tells a live session from an exited one', () => {
  const t0 = now - 3 * H
  const snap = t0 + 10 * 60e3 // first Bash call ten minutes into the session
  const procs = [
    proc(100, 4, 'claude.exe', 'claude.exe', t0),
    proc(500, 997, 'bash.exe', bashCmd(snap), snap + 60e3),
    proc(501, 500, 'node.exe', 'node C:\\w\\node_modules\\vitest\\dist\\workers\\forks.js', snap + 61e3),
  ]
  const listening = new Set()
  // file still there and a Claude older than it is running: it may be that session's
  assert.deepStrictEqual(findOrphans({ procs, listening }, now, win({ snapshotExists: existing(snap) })), [])
  // file removed: that session has exited
  assert.deepStrictEqual(pairs(findOrphans({ procs, listening }, now, win())), [[501, 500]])
  // file left after a crash, and every running Claude is younger than it
  const younger = [proc(100, 4, 'claude.exe', 'claude.exe', snap + H), ...procs.slice(1)]
  assert.deepStrictEqual(pairs(findOrphans({ procs: younger, listening }, now, win({ snapshotExists: existing(snap) }))), [[501, 500]])
  // file removed, but another live shell of a running session still uses that snapshot
  const shared = [...procs, proc(510, 100, 'bash.exe', bashCmd(snap), now - 60e3)]
  assert.deepStrictEqual(findOrphans({ procs: shared, listening }, now, win()), [])
})

test('after SessionEnd only that session is reaped, with exact proof for PowerShell shells', () => {
  const A = 2000
  const since = now - 2 * H
  const session = { pid: A, since, endedAt: now }
  const vitest = 'node C:\\w\\node_modules\\vitest\\dist\\workers\\forks.js'
  const procs = [
    proc(100, 4, 'claude.exe', 'claude.exe', now - 30 * H),
    // A's PowerShell tool shell, an hour old, whose parent is A itself
    proc(2100, A, 'powershell.exe', psCmd, now - H),
    proc(2101, 2100, 'node.exe', vitest, now - H),
    // A's Bash shell whose wrapper exited; the snapshot was written during A's lifetime
    proc(2200, 2199, 'bash.exe', bashCmd(since + 90e3), now - H),
    proc(2201, 2200, 'node.exe', 'node server.js', now - H),
    // another dead session B: its snapshot predates A, its PowerShell shell hangs off B
    proc(3100, 3000, 'powershell.exe', psCmd, now - H),
    proc(3101, 3100, 'node.exe', vitest, now - H),
    proc(3200, 3199, 'bash.exe', bashCmd(since - H), now - H),
    proc(3201, 3200, 'node.exe', vitest, now - H),
    // parent PID equals A, but the shell is older than A: an earlier holder of that PID
    proc(2300, A, 'powershell.exe', psCmd, since - H),
    proc(2301, 2300, 'node.exe', vitest, since - H),
  ]
  const listening = new Set([2201])
  assert.deepStrictEqual(pairs(findOrphans({ procs, listening }, now, win({ session }))), [[2101, 2100], [2201, 2200]])
  // without a session the PowerShell shells wait for the 6-hour rule
  assert.deepStrictEqual(pairs(findOrphans({ procs, listening }, now, win())), [[2201, 2200], [3201, 3200]])
  // Linux: CLAUDE_PID decides, and a process older than the session is not its child
  const linux = [
    proc(1, 0, 'systemd', '/sbin/init', now - 50 * H),
    proc(40, 1, 'node', 'node /w/node_modules/vitest/dist/workers/forks.js', now - H, A),
    proc(41, 1, 'node', 'node /w/node_modules/vitest/dist/workers/forks.js', now - H, 3000),
    proc(42, 1, 'node', 'node /w/node_modules/vitest/dist/workers/forks.js', since - H, A),
  ]
  assert.deepStrictEqual(pairs(findOrphans({ procs: linux, listening: new Set() }, now, { session, platform: 'linux' })), [[40, 40]])
})

test('linux: ownership comes from CLAUDE_PID in the environment', () => {
  const t0 = now - 5 * H
  const procs = [
    proc(1, 0, 'systemd', '/sbin/init', t0 - H),
    proc(10, 9, 'claude', 'claude', t0),
    proc(20, 1, 'node', 'node next dev', t0 + 1000, 10),
    proc(29, 1, 'npm run dev', 'npm run dev', t0, 55),
    proc(30, 29, 'node', 'node vite', t0, 55),
    proc(31, 30, 'esbuild', 'esbuild --service', t0, 55),
    proc(40, 1, 'node', 'node old.js', t0 - 1000, 10),
    proc(50, 1, 'node', 'node mine.js', t0, null),
    proc(60, 1, 'python3', 'python3 -m http.server', t0, null),
  ]
  const found = findOrphans({ procs, listening: new Set([20, 30, 40, 50, 60]) }, now, { platform: 'linux' })
  assert.deepStrictEqual(found.map(o => [o.pid, o.top]), [[30, 29], [40, 40]])
  assert.match(found[1].why, /newer process/)
  assert.deepStrictEqual(descendants(29, procs), [29, 30, 31])
})

test('linux: test workers, xdist workers and watchers of an exited session; never the user\'s editor or tmux', () => {
  const t0 = now - 5 * H
  const procs = [
    proc(1, 0, 'systemd', '/sbin/init', t0 - H),
    proc(10, 9, 'claude', '/home/dev/.local/bin/claude', t0),
    // session 77 has exited
    proc(100, 1, 'python3', '/usr/bin/python3 -m pytest -n 4', t0, 77),
    proc(101, 100, 'python3', '/usr/bin/python3 -c import sys;exec(eval(sys.stdin.readline()))', t0, 77),
    proc(102, 1, 'python3', '/usr/bin/python3 -c import sys;exec(eval(sys.stdin.readline()))', t0, 77),
    proc(110, 1, 'node', 'node /w/node_modules/typescript/bin/tsc --watch', t0, 77),
    proc(120, 1, 'headless_shell', '/home/dev/.cache/ms-playwright/chromium_headless_shell-1169/chrome-linux/headless_shell --headless', t0, 77),
    proc(121, 120, 'headless_shell', '/home/dev/.cache/ms-playwright/chromium_headless_shell-1169/chrome-linux/headless_shell --type=renderer', t0, 77),
    // `code .` and `tmux` from that session's shell, and what the user runs inside them
    proc(200, 1, 'code', '/usr/share/code/code .', t0, 77),
    proc(201, 200, 'bash', '/bin/bash', t0 + 1000, 77),
    proc(202, 201, 'node', 'node /w/node_modules/vitest/vitest.mjs', t0 + 2000, 77),
    proc(210, 1, 'tmux: server', 'tmux new -s work', t0, 77),
    proc(211, 210, 'bash', '-bash', t0 + 1000, 77),
    proc(212, 211, 'node', 'node /w/node_modules/jest/bin/jest.js --watch', t0 + 2000, 77),
    // live session 10
    proc(300, 1, 'node', 'node /w/node_modules/vitest/vitest.mjs', t0 + 5000, 10),
  ]
  const found = findOrphans({ procs, listening: new Set() }, now, { platform: 'linux' })
  assert.deepStrictEqual(found.map(o => [o.pid, o.rule]), [[100, 'test-runner'], [102, 'test-runner'], [110, 'watcher'], [120, 'headless-browser']])
  assert.deepStrictEqual(descendants(100, procs), [100, 101])
  assert.strictEqual(ruleFor(procs[7]), null)
})

test('linux: the chain fallback never climbs past a Claude shell', () => {
  const procs = [
    proc(1, 0, 'systemd', '/sbin/init', now - 50 * H),
    proc(5, 1, 'systemd', '/lib/systemd/systemd --user', now - 50 * H),
    proc(70, 5, 'bash', `/bin/bash -c source /home/dev/.claude/shell-snapshots/snapshot-bash-${now - 30 * H}-zz.sh && eval 'npm start'`, now - 30 * H),
    proc(71, 70, 'node', 'node server.js', now - 30 * H),
  ]
  const found = findOrphans({ procs, listening: new Set([71]) }, now, { platform: 'linux', snapshotExists: existing() })
  assert.deepStrictEqual(found.map(o => [o.pid, o.top]), [[71, 70]])
})

test('macOS: GUI apps are kept, browsers for testing are not', () => {
  const t0 = now - 5 * H
  const procs = [
    proc(1, 0, 'launchd', '/sbin/launchd', t0 - H),
    proc(90, 1, 'Electron', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', t0, 77),
    proc(91, 1, 'Google Chrome for Testing', '/Users/dev/Library/Caches/ms-playwright/chromium-1169/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --headless --remote-debugging-pipe', t0, 77),
  ]
  const found = findOrphans({ procs, listening: new Set([90]) }, now, { platform: 'darwin' })
  assert.deepStrictEqual(found.map(o => [o.pid, o.rule]), [[91, 'headless-browser']])
})

test('the rule table and the keep list are documented with a reason each', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'guards', 'orphan-reaper.md'), 'utf8')
  for (const r of [...RULES, ...reaper.KEEP]) {
    assert.ok(r.reason && r.what, `${r.what} has a reason`)
    assert.ok(doc.includes(r.what), `docs/guards/orphan-reaper.md lists "${r.what}"`)
  }
})

test('snapshot paths and whether the file is still there', () => {
  assert.strictEqual(snapshotPath(bashCmd(1791860359256), 'win32'), 'C:/Users/dev/.claude/shell-snapshots/snapshot-bash-1791860359256-ab12cd.sh')
  assert.strictEqual(snapshotPath(`bash -c "source '/home/a b/.claude/shell-snapshots/snapshot-zsh-1791860359256-x1.sh' && ls"`, 'linux'), '/home/a b/.claude/shell-snapshots/snapshot-zsh-1791860359256-x1.sh')
  // unquoted path with a space: only the tail is seen, which is not absolute, so unknown
  assert.strictEqual(snapshotPath('bash -c source /home/a b/.claude/shell-snapshots/snapshot-bash-1791860359256-x1.sh', 'linux'), null)
  assert.strictEqual(snapshotPath(psCmd, 'win32'), null)
  const dir = tempDir()
  const snaps = path.join(dir, 'shell-snapshots')
  fs.mkdirSync(snaps)
  fs.writeFileSync(path.join(snaps, 'snapshot-bash-1-a.sh'), '')
  assert.strictEqual(snapshotExists(path.join(snaps, 'snapshot-bash-1-a.sh')), true)
  assert.strictEqual(snapshotExists(path.join(snaps, 'snapshot-bash-2-a.sh')), false)
  assert.strictEqual(snapshotExists(path.join(dir, 'missing', 'snapshot-bash-2-a.sh')), true)
  assert.strictEqual(snapshotExists(null), true)
})

test('SessionEnd finds the Claude process and its exact start, and skips clear and resume', () => {
  const dir = tempDir()
  // procStart is a Windows FILETIME; 134363339487408195 is 1791860348740 ms
  fs.writeFileSync(path.join(dir, '28552.json'), JSON.stringify({ pid: 28552, sessionId: 's1', startedAt: 1791860353407, procStart: '134363339487408195' }))
  fs.writeFileSync(path.join(dir, '400.json'), JSON.stringify({ pid: 400, sessionId: 's2', startedAt: 1791860000000 }))
  assert.deepStrictEqual(sessionOf({ session_id: 's1' }, { dir, env: {} }), { pid: 28552, since: 1791860348740 })
  assert.deepStrictEqual(sessionOf({ session_id: 's2' }, { dir, env: {} }), { pid: 400, since: 1791860000000 - 120e3 })
  assert.deepStrictEqual(sessionOf({ session_id: 'gone' }, { dir, env: { CLAUDE_PID: '77' }, ppid: 5 }), { pid: 77, since: 0 })
  assert.deepStrictEqual(sessionOf({}, { dir: path.join(dir, 'none'), env: {}, ppid: 5 }), { pid: 5, since: 0 })
  const started = []
  assert.strictEqual(onSessionEnd({ reason: 'clear', session_id: 's1' }, { start: a => started.push(a) }), null)
  assert.strictEqual(onSessionEnd({ reason: 'resume', session_id: 's1' }, { start: a => started.push(a) }), null)
  const args = onSessionEnd({ reason: 'prompt_input_exit', session_id: 'x', cwd: '/w/app' }, { env: { CLAUDE_PID: '4242' }, start: a => started.push(a) })
  assert.deepStrictEqual(args.slice(0, 2), ['--after-exit', '4242'])
  assert.ok(args.includes('/w/app'))
  assert.strictEqual(started.length, 1)
})

test('bulkhead reap prints the plan, as text and JSON', () => {
  const { main } = require('../src/reap-cli')
  const out = []
  const stdout = { write: s => out.push(s), isTTY: false }
  const o = { pid: 501, top: 500, name: 'node.exe', cmd: 'node vitest.mjs', rule: 'test-runner', what: 'Vitest', why: 'its session has exited', owner: 9 }
  main(['--dry-run'], { stdout, platform: 'win32', run: () => [{ orphan: o, pids: [500, 501] }] })
  assert.match(out.join(''), /would stop 501 {2}test-runner {2}node vitest\.mjs\n {2}Vitest; its session has exited; 2 processes from 500\n1 tree would be stopped/)
  out.length = 0
  main(['--json'], { stdout, platform: 'win32', run: () => [] })
  assert.deepStrictEqual(JSON.parse(out.join('')), { supported: true, dryRun: false, orphans: [] })
  out.length = 0
  main([], { stdout, platform: 'linux', run: () => [] })
  assert.match(out.join(''), /nothing to stop/)
})

// Real processes: a fake Claude starts a tool shell, the shell starts a test worker, and the fake
// Claude exits. Another exited session's worker must survive the first session's waiter.
const supported = ['win32', 'linux', 'darwin'].includes(process.platform)

function fakeTree(dir, label, snapshotMs) {
  const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  const shell = path.join(dir, 'shell.js')
  const worker = path.join(dir, 'node_modules', 'vitest', 'dist', 'workers', 'forks.js')
  if (!fs.existsSync(cli)) {
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.mkdirSync(path.dirname(worker), { recursive: true })
    fs.mkdirSync(path.join(dir, '.claude', 'shell-snapshots'), { recursive: true })
    fs.writeFileSync(cli, `
const { spawn } = require('child_process')
const [shell, snapshot, out, holdMs] = process.argv.slice(2)
// detached: on Windows libuv would otherwise put the shell in a job that dies with this process
spawn(process.execPath, [shell, 'source', snapshot, out], { stdio: 'ignore', detached: true, env: { ...process.env, CLAUDE_PID: String(process.pid) } }).unref()
setTimeout(() => process.exit(0), Number(holdMs))
`)
    fs.writeFileSync(shell, `
const fs = require('fs')
const { spawn } = require('child_process')
const path = require('path')
const out = process.argv[4]
// the worker path is not on this command line, so only the worker matches the vitest rule
const w = spawn(process.execPath, [path.join(__dirname, 'node_modules', 'vitest', 'dist', 'workers', 'forks.js')], { stdio: 'ignore' })
fs.writeFileSync(out, JSON.stringify({ shell: process.pid, worker: w.pid }))
setInterval(() => {}, 1000)
`)
    fs.writeFileSync(worker, 'setInterval(() => {}, 1000)\n')
  }
  const snapshot = path.join(dir, '.claude', 'shell-snapshots', `snapshot-bash-${snapshotMs}-${label}.sh`)
  return { cli, shell, worker, snapshot, out: path.join(dir, `${label}.json`) }
}

function startFake(t, holdMs) {
  return spawn(process.execPath, [t.cli, t.shell, t.snapshot, t.out, String(holdMs)], { stdio: 'ignore' })
}

async function until(cond, ms, what) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

const isAlive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const stop = pid => { try { process.kill(pid) } catch {} }

function waiter(args, state, cwd) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'src', 'orphan-reaper.js'), ...args], {
    stdio: 'ignore',
    cwd,
    env: { ...process.env, BULKHEAD_DISABLE: '', BULKHEAD_STATE_DIR: state, BULKHEAD_NO_LOG: '', CLAUDE_PROJECT_DIR: cwd },
  })
}

test('the SessionEnd waiter reaps only its own session after it exits', { skip: !supported, timeout: 90000 }, async () => {
  const dir = tempDir()
  const state = tempDir()
  const since = Date.now() - 1000
  const a = fakeTree(dir, 'aaa', since + 500)
  const b = fakeTree(dir, 'bbb', since - 3600e3)
  const fakeA = startFake(a, 4000)
  const fakeB = startFake(b, 1500)
  const pids = []
  try {
    await until(() => fs.existsSync(a.out) && fs.existsSync(b.out), 15000, 'the fake sessions')
    const A = JSON.parse(fs.readFileSync(a.out, 'utf8'))
    const B = JSON.parse(fs.readFileSync(b.out, 'utf8'))
    pids.push(A.shell, A.worker, B.shell, B.worker)
    const w = waiter(['--after-exit', String(fakeA.pid), '--since', String(since), '--max-wait', '60', '--session', 'sess-a', '--project', dir], state, dir)
    const code = await new Promise(resolve => w.on('exit', resolve))
    assert.strictEqual(code, 0)
    // On Windows this process still holds fakeA's handle until its exit event is handled, and
    // kill(pid, 0) reports a process whose handle is open as alive, so wait for that event.
    await until(() => fakeA.exitCode !== null || fakeA.signalCode !== null, 5000, 'the exit of fake Claude A')
    assert.ok(!isAlive(fakeA.pid), 'the waiter returned only after its Claude exited')
    await until(() => !isAlive(A.worker) && !isAlive(A.shell), 10000, 'session A to be stopped')
    assert.ok(isAlive(B.worker) && isAlive(B.shell), 'session B is not the exited session, so it is left alone')
    const events = fs.readFileSync(path.join(state, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.deepStrictEqual(events.map(e => [e.guard, e.rule, e.pid, e.trigger, e.session, e.project]), [['orphan-reaper', 'test-runner', A.worker, 'session-end', 'sess-a', dir]])
  } finally {
    for (const pid of pids) stop(pid)
    stop(fakeA.pid)
    stop(fakeB.pid)
  }
})

test('the SessionEnd waiter gives up when its Claude keeps running', { skip: !supported, timeout: 60000 }, async () => {
  const dir = tempDir()
  const state = tempDir()
  const since = Date.now() - 1000
  const c = fakeTree(dir, 'ccc', since + 500)
  const fake = startFake(c, 60000)
  const pids = [fake.pid]
  try {
    await until(() => fs.existsSync(c.out), 15000, 'the fake session')
    const C = JSON.parse(fs.readFileSync(c.out, 'utf8'))
    pids.push(C.shell, C.worker)
    const t0 = Date.now()
    const w = waiter(['--after-exit', String(fake.pid), '--since', String(since), '--max-wait', '2'], state, dir)
    await new Promise(resolve => w.on('exit', resolve))
    assert.ok(Date.now() - t0 < 30000)
    assert.ok(isAlive(fake.pid) && isAlive(C.worker), 'nothing was stopped')
    assert.match(fs.readFileSync(path.join(state, 'guards.log'), 'utf8'), /gave up waiting for Claude PID \d+ after 2 s/)
  } finally {
    for (const pid of pids) stop(pid)
  }
})

test('the SessionEnd hook returns at once and leaves a waiter behind', { skip: !supported, timeout: 60000 }, async () => {
  const dir = tempDir()
  const state = tempDir()
  const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  const deadPid = Number(gone.stdout)
  fs.mkdirSync(path.join(dir, 'sessions'))
  fs.writeFileSync(path.join(dir, 'sessions', `${deadPid}.json`), JSON.stringify({ pid: deadPid, sessionId: 'ended', startedAt: Date.now() - 60000 }))
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'orphan-reaper.js'), '--session-end'], {
    input: JSON.stringify({ session_id: 'ended', reason: 'other', hook_event_name: 'SessionEnd', cwd: dir }),
    encoding: 'utf8',
    env: { ...process.env, BULKHEAD_DISABLE: '', BULKHEAD_STATE_DIR: state, CLAUDE_CONFIG_DIR: dir, CLAUDE_PROJECT_DIR: dir },
  })
  assert.strictEqual(r.status, 0)
  assert.ok(Date.now() - t0 < 5000, 'well inside the SessionEnd budget')
  const logFile = path.join(state, 'guards.log')
  await until(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes(`session ${deadPid} exited`), 30000, 'the waiter')
})

test('parses the PowerShell process snapshot', () => {
  const json = JSON.stringify({
    procs: [{ pid: 4, ppid: 0, name: 'System', cmd: null, start: 0 }, { pid: 88, ppid: 4, name: 'node.exe', cmd: 'node a.js', start: 1760000000000, rss: 52428800 }],
    listen: [{ pid: 88, port: 3000 }, { pid: 88, port: 3000 }, { pid: 88, port: 24678 }],
  })
  const s = parseWindows(json)
  assert.strictEqual(s.procs.length, 2)
  assert.strictEqual(s.procs[0].cmd, '')
  assert.strictEqual(s.procs[1].rss, 52428800)
  assert.ok(s.listening.has(88))
  assert.deepStrictEqual(s.ports, [{ port: 3000, pid: 88 }, { port: 24678, pid: 88 }])
})

test('parses /proc entries', () => {
  assert.deepStrictEqual(parseProcStat('4242 (node (dev) x) S 4200 4242 4242 0 -1 4194560 0 0 0 0 1 2 0 0 20 0 11 0 987654 1000 200'), {
    name: 'node (dev) x', ppid: 4200, startTicks: 987654, rssPages: 200,
  })
  const tcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55501 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:A1B2 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 55502 1 0000000000000000 20 4 30 10 -1',
  ].join('\n')
  assert.deepStrictEqual([...parseNetTcp(tcp)], [['55501', 3000]])
  assert.strictEqual(envValue('A=1\0CLAUDE_PID=321\0B=2', 'CLAUDE_PID'), '321')
})

test('reads a fake /proc tree', () => {
  const files = {
    '/proc/stat': 'cpu 1 2 3\nbtime 1760000000\n',
    '/proc/net/tcp': 'header\n   0: 00000000:0BB8 00000000:0000 0A 0:0 0:0 0 1000 0 777 1\n',
    '/proc/42/stat': '42 (node) S 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 500 0 2560',
    '/proc/42/cmdline': 'node\0server.js\0',
    '/proc/42/environ': 'HOME=/home/dev\0CLAUDE_PID=7\0',
  }
  const io = {
    read: p => { if (p in files) return files[p]; throw new Error('ENOENT') },
    list: p => ({ '/proc': ['1x', '42', 'self'], '/proc/42/fd': ['0', '1', '9'] })[p] || [],
    link: p => (p === '/proc/42/fd/9' ? 'socket:[777]' : '/dev/null'),
  }
  const { procs, listening, ports } = readLinux(io, 100)
  assert.deepStrictEqual(procs, [{ pid: 42, ppid: 1, name: 'node', cmd: 'node server.js', start: 1760000005000, rss: 2560 * 4096, claudePid: 7 }])
  assert.ok(listening.has(42))
  assert.deepStrictEqual(ports, [{ port: 3000, pid: 42 }])
})

test('a Node 24 process, whose main thread is named MainThread, still reads as node', () => {
  // Node 24 renames its main thread, and on Linux that is the comm in /proc/<pid>/stat. Claude Code
  // on Node 24 then failed isClaude, and the SessionEnd waiter reaped a session that was running.
  const cli = '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'
  const files = {
    '/proc/stat': 'cpu 1 2 3\nbtime 1760000000\n',
    '/proc/42/stat': '42 (MainThread) S 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 500 0 2560',
    '/proc/42/cmdline': `/usr/bin/node\0${cli}\0`,
  }
  const io = { read: p => { if (p in files) return files[p]; throw new Error('ENOENT') }, list: p => (p === '/proc' ? ['42'] : []), link: () => '' }
  const [p] = readLinux(io, 100).procs
  assert.strictEqual(p.name, 'node')
  assert.ok(reaper.isClaude(p))
  assert.ok(require('../src/sessions').isClaudeCli(p))
})
