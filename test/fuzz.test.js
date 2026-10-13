'use strict'
// Robustness: thousands of random and mutated commands (deterministic seed) go through every
// guard's check function in-process, and a sample goes through the real hook scripts.
// A guard must never throw, must answer quickly, and a hook must exit 0 or 2 without a stack trace.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const H = require('./corpus/harness')

const kill = require('../src/kill-guard')
const wait = require('../src/wait-guard')
const memory = require('../src/memory-guard')
const basics = require('../src/basics')
const checkout = require('../src/checkout-guard')
const port = require('../src/port-guard')
const devServers = require('../src/dev-servers')
const shell = require('../src/shell')

const SEED = Number(process.env.FUZZ_SEED) || 0x5eed1234
const COUNT = Number(process.env.FUZZ_COUNT) || 3000
const LIMIT_MS = 300

// mulberry32: small, fast, and the same sequence on every platform.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VOCAB = [
  'pkill', 'killall', 'kill', '-9', '-f', '-s', '0', 'node', 'python', 'chrome', 'node.exe', 'taskkill', '/F', '//F', '/IM', '/FI',
  '"IMAGENAME eq node.exe"', '/PID', '4312', 'Stop-Process', '-Name', '-Id', 'Get-Process', 'gps', '|', '||', '&&', ';', '&', '\n',
  'xargs', 'pgrep', 'ps', 'aux', 'grep', 'awk', 'wmic', 'process', 'where', 'name=', 'delete', 'Win32_Process', 'Terminate',
  'sleep', '300', '5m', '1h', 'Start-Sleep', '-Seconds', 'for', 'while', 'until', 'do', 'done', '{1..99}', 'seq', '1', '100',
  'timeout', '60', 'ForEach-Object', '%', '{', '}', '(', ')', '$(', '`', 'cat', '>', '>>', '<<', "<<'EOF'", 'EOF', 'tee', '-a',
  'npm', 'run', 'dev', 'build', 'test', 'npx', 'next', 'vite', '--port', '-p', '3000', 'PORT=3000', '$env:PORT', '=', 'uvicorn',
  'python', '-m', 'http.server', 'manage.py', 'runserver', 'cd', '..', '~', '/', '/*', 'C:\\', '$HOME', '%USERPROFILE%', 'rm', '-rf',
  'Remove-Item', '-Recurse', '-Force', 'rd', '/s', '/q', 'git', '-C', '-c', 'checkout', 'switch', 'stash', 'pop', 'reset', '--hard',
  'clean', '-fdx', 'rebase', 'merge', 'pull', 'push', '--force', '-f', '+main', 'origin', 'main', 'master', 'HEAD', '--', '.',
  'vitest', 'gradlew', 'emulator', '-avd', 'docker', 'build', 'slot-1.json', 'bulkhead/slots', 'touch', 'bash', '-c', 'sh', 'cmd',
  '/c', 'powershell', '-Command', 'echo', 'printf', '"', "'", '\\', '\\"', '$', '*', '?', '[n]ode', '\0', '\u0000', '\t', '\r\n',
  '한글', 'дом', '🙂', '\u202e', '\ufeff', '\ud800', 'ｐｋｉｌｌ', 'ｎｏｄｅ',
]

function randomCommand(r) {
  const n = 1 + Math.floor(r() * 24)
  const out = []
  for (let i = 0; i < n; i++) {
    const roll = r()
    if (roll < 0.8) out.push(VOCAB[Math.floor(r() * VOCAB.length)])
    else if (roll < 0.9) out.push(String.fromCharCode(Math.floor(r() * 0x2fff)))
    else out.push(Math.floor(r() * 70000).toString())
  }
  return out.join(r() < 0.7 ? ' ' : '')
}

function mutate(s, r) {
  let out = s
  const steps = 1 + Math.floor(r() * 6)
  for (let i = 0; i < steps; i++) {
    const at = Math.floor(r() * (out.length + 1))
    const roll = r()
    if (roll < 0.25) out = out.slice(0, at) + VOCAB[Math.floor(r() * VOCAB.length)] + out.slice(at)
    else if (roll < 0.45) out = out.slice(0, at) + out.slice(at + 1 + Math.floor(r() * 4))
    else if (roll < 0.6) out = out.slice(0, at) + ['"', "'", '`', '\\', '\0', '(', '{'][Math.floor(r() * 7)] + out.slice(at)
    else if (roll < 0.75) out = out + ' ' + ['&&', ';', '|', '||', '\n'][Math.floor(r() * 5)] + ' ' + out
    else if (roll < 0.9) out = out.toUpperCase()
    else out = out.slice(0, at) + String.fromCodePoint(Math.floor(r() * 0x10ffff) & 0xfffff) + out.slice(at)
  }
  return out
}

const MB = 1024 * 1024
const fill = (unit, size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size)

// Long inputs (1 MB) shaped to stress regular expressions: repeated flags, quotes, loops, heredocs.
const LONG = {
  letters: n => fill('a', n),
  'pkill words': n => fill('pkill ', n),
  'pkill short flags': n => 'pkill' + fill(' -a 1', n) + ' node',
  'killall long flags': n => 'killall' + fill(' --x', n),
  'taskkill flags': n => 'taskkill' + fill(' /F', n) + ' /IM node.exe',
  'Get-Process pipes': n => 'Get-Process node ' + fill('| x ', n) + '| Stop-Process',
  'double quotes': n => fill('"', n),
  'open double quotes': n => fill('"a', n),
  'open single quotes': n => fill("'x", n),
  'escaped quotes': n => fill('\\"', n),
  'sleep chain': n => fill('sleep 1; ', n),
  'sleep lines': n => fill('sleep 1\n', n),
  'long for list': n => 'for i in ' + fill('a ', n) + '; do sleep 9; done',
  'brace ranges': n => fill('{1..9}', n),
  'Start-Sleep chain': n => fill('Start-Sleep 1;', n),
  'one long heredoc': n => "cat > f <<'EOF'\n" + fill('line\n', n),
  'unterminated heredocs': n => fill("cat > f <<'EOF'\n", n),
  'distinct unterminated heredocs': n => {
    let s = ''
    for (let i = 0; s.length < n; i++) s += `cat > f <<T${i}\nx\n`
    return s.slice(0, n)
  },
  'echo chain': n => fill('echo x && ', n),
  'rm parents': n => 'rm -rf ' + fill('../', n),
  'rm flags': n => 'rm ' + fill('-r ', n) + '/',
  'git -C chain': n => 'git ' + fill('-C . ', n) + 'checkout main',
  'push refspecs': n => 'git push ' + fill('+main ', n),
  'npx chain': n => fill('npx ', n) + 'next dev',
  'env prefixes': n => fill('A=1 ', n) + 'next dev',
  'PowerShell env': n => fill('$env:PORT = 1; ', n),
  'ps grep pipes': n => fill('ps aux | grep node ', n),
  NULs: n => fill('\0', n),
  hangul: n => fill('한', n / 2),
  newlines: n => fill('\n', n),
  'CRLF lines': n => fill('\r\n', n),
  'escaped newlines': n => fill('\\\n', n),
  spaces: n => fill(' ', n),
  pipes: n => fill('|', n),
  semicolons: n => fill(';', n),
  // shell wrappers and the lexer's nesting
  'bash -c nesting': n => fill('bash -c "', n),
  'sh -c single quotes': n => fill("sh -c '", n),
  'powershell -Command chain': n => fill('powershell -NoProfile -Command ', n),
  'cmd /c chain': n => fill('cmd /c ', n),
  'Start-Process chain': n => fill('Start-Process taskkill -ArgumentList ', n),
  'encoded command': n => 'powershell -EncodedCommand ' + Buffer.from(fill('Stop-Process -Name node; ', Math.floor(n / 3)), 'utf16le').toString('base64').slice(0, n),
  'sudo chain': n => fill('sudo ', n) + 'pkill node',
  'env chain': n => fill('env A=1 ', n) + 'git checkout main',
  'assignments': n => fill('A=1 ', n) + 'git checkout main',
  'xargs chain': n => fill('xargs -I{} ', n),
  'timeout chain': n => fill('timeout 5 ', n) + 'sleep 600',
  'subshell opens': n => fill('$(', n),
  'subshell closes': n => fill(')', n),
  'process substitutions': n => fill('<(', n),
  backticks: n => fill('`', n),
  parens: n => fill('(', n),
  braces: n => fill('{ ', n),
  'dollar braces': n => fill('${', n),
  'unterminated quote then commands': n => "'" + fill('pkill node; ', n),
  // kill-guard rules
  'Where-Object chain': n => 'Get-Process | ' + fill('Where-Object { $_.Name -eq node } | ', n) + 'Stop-Process',
  'Win32_Process chain': n => fill('Get-CimInstance Win32_Process ', n),
  'wmic chain': n => fill('wmic process where name=node.exe ', n),
  'taskkill /IM list': n => 'taskkill' + fill(' /IM node.exe', n),
  'Stop-Process name list': n => 'Stop-Process -Name ' + fill('node,', n),
  'pgrep variables': n => fill('p=$(pgrep node); ', n) + 'kill $p',
  'grep pipeline': n => 'ps aux' + fill(' | grep node', n),
  'killall operands': n => 'killall -r' + fill(' no.e', n),
  // wait-guard rules
  'for in lists': n => fill('for i in ', n),
  'for loops': n => fill('for i in 1 2; do sleep 1; done; ', n),
  'C for loops': n => fill('for ((i=0', n),
  'python sleeps': n => 'python -c "' + fill('time.sleep(1);', n) + '"',
  'setTimeout chain': n => 'node -e "' + fill('setTimeout(f,', n) + '"',
  'ping chain': n => fill('ping -n 5 ', n),
  'tail -f chain': n => fill('tail -f a ', n),
  // never-executed text
  'message flags': n => 'git commit' + fill(' -m "x"', n),
  'gh body': n => 'gh pr create --body "' + fill('pkill node ', n) + '"',
  'heredoc openers on one line': n => fill('cat <<A ', n),
  'git heredocs': n => fill('git commit -F - <<EOF\nx\n', n),
  // port-guard kill by port
  'kill-port chain': n => 'npx kill-port' + fill(' 3000', n),
  'lsof chain': n => fill('lsof -ti :3000 ', n) + '| xargs kill',
  'netstat chain': n => fill('netstat -ano | findstr :3000 ', n) + '| taskkill',
  'rm operands': n => 'rm -rf --' + fill(' /', n),
}

function inputs() {
  const r = rng(SEED)
  const corpus = [
    ...H.readCorpus(path.join(__dirname, 'corpus', 'allow.txt')).map(e => H.decode(e.raw)),
    ...H.readCorpus(path.join(__dirname, 'corpus', 'block.txt')).map(e => H.decode(e.raw.split('\t').slice(1).join('\t'))),
  ]
  const out = []
  for (let i = 0; i < COUNT; i++) {
    out.push(r() < 0.5 ? randomCommand(r) : mutate(corpus[Math.floor(r() * corpus.length)], r))
  }
  return out
}

// Fakes so no check reaches git, the process table or the network.
// Under /tmp, not /home: basics resolves the real cwd and home, and /home on macOS is an
// automount point whose lookups can take hundreds of milliseconds for a user that does not exist.
const home = process.platform === 'win32' ? 'C:\\Users\\dev' : '/tmp/bulkhead-fuzz/home/dev'
const repo = process.platform === 'win32' ? 'C:\\work\\shop' : '/tmp/bulkhead-fuzz/work/shop'
const fakeGit = args => (args[0] === 'rev-parse' ? (args.includes('--abbrev-ref') ? 'main' : repo) : ' M src/app.js\n?? notes.txt')
const pkg = JSON.stringify({ scripts: { dev: 'next dev', start: 'npm run dev', loop: 'npm run loop' } })
const other = () => new Map([[process.pid, { cwd: repo, startedAt: 0, sessionId: 'other' }]])
const snap = H.busySnapshot()

const portFakes = { probe: async () => true, snapshot: () => snap, files: () => new Map(), self: () => 900200 }

// Each check is a list of calls, one per hook invocation it stands for, in both lexer modes: the
// Bash tool's and the PowerShell tool's. The time limit applies to each call, as a hook makes one.
const CHECKS = {
  'kill-guard': [c => kill.check(c), c => kill.check(c, {}, 'ps')],
  'wait-guard': [c => wait.judge(c, 600000), c => wait.judge(c, undefined), c => wait.judge(c, 'x'), c => wait.judge(c, 600000, 180, 'ps')],
  'memory-guard': [c => memory.check(c, () => H.PLENTY), c => memory.check(c, () => H.LOW, undefined, 'ps')],
  basics: [c => basics.check(c, { cwd: repo, home, run: fakeGit }), c => basics.check(c, { cwd: repo, home, run: fakeGit, mode: 'ps' })],
  'checkout-guard': [c => checkout.check(c, { cwd: repo, sessionId: 'me', files: other, isAlive: () => true, run: fakeGit })],
  'dev-servers': [c => devServers.detect(c, { cwd: repo, readFile: () => pkg })],
  // port-guard's hook runs both: a dev server start and a kill by port
  'port-guard': [c => Promise.all([port.check(c, { cwd: repo, ...portFakes }), port.checkKill(c, portFakes)])],
  shell: [c => shell.commands(c), c => shell.commands(c, 'ps'), c => shell.commands(c, 'cmd'), c => shell.unwrap(c, 'sh', 0, { remote: true }), c => shell.prepare(c)],
}

const describe = c => `${JSON.stringify(c.slice(0, 60))} (${c.length} chars)`

// The slowest call of a check, and the first error.
async function timed(calls, c) {
  let ms = 0
  let error = null
  for (const call of calls) {
    const started = process.hrtime.bigint()
    try {
      await call(c)
    } catch (e) {
      error = error || (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : String(e))
    }
    ms = Math.max(ms, Number(process.hrtime.bigint() - started) / 1e6)
  }
  return { ms, error }
}

// Best of three: one run can land on a garbage collection or a busy CI runner and look
// several times slower than the code is, which made the growth check flaky on macOS.
async function timedBest(calls, c, runs = 3) {
  let best = null
  for (let i = 0; i < runs; i++) {
    const r = await timed(calls, c)
    if (r.error) return r
    if (!best || r.ms < best.ms) best = r
  }
  return best
}

// Times one shape at 1/8, 1/4, 1/2 and 1 MB (best of five each) and fits log(time) against
// log(size) by least squares. One slow run moves a single point; the slope across four sizes
// stays near 1 for linear code and near 2 for quadratic.
async function growth(calls, make) {
  const pts = []
  for (const f of [1 / 8, 1 / 4, 1 / 2, 1]) {
    const r = await timedBest(calls, make(Math.round(MB * f)), 5)
    pts.push([Math.log(f), Math.log(Math.max(r.ms, 0.1)), r.ms, f])
  }
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length
  const slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0)
  // Time ratio per doubling: about 2 for linear code, 2.8 for size^1.5, 4 for quadratic, and the
  // same at every step. Noise is not: a run that crosses a GC or cache threshold makes one step
  // jump (14, 31, 191, 424 ms, and 9, 30, 77, 259 ms on macOS runners), so the smallest step counts.
  const ratios = pts.slice(1).map((p, i) => Math.max(p[2], 0.1) / Math.max(pts[i][2], 0.1))
  return { slope, least: Math.min(...ratios), text: pts.map(p => `${Math.round(p[2])} ms at ${p[3]} MB`).join(', ') }
}

test('fuzz: check functions never throw and stay fast on random and mutated commands', { timeout: 600000 }, async t => {
  const all = inputs()
  const slow = []
  const thrown = []
  const worst = {}
  for (const [name, fn] of Object.entries(CHECKS)) {
    worst[name] = 0
    for (const c of all) {
      const { ms, error } = await timed(fn, c)
      if (error) thrown.push(`${name}: ${error} <- ${describe(c)}`)
      worst[name] = Math.max(worst[name], Math.round(ms))
      if (ms > LIMIT_MS) slow.push(`${name}: ${Math.round(ms)} ms on ${describe(c)}`)
    }
  }
  t.diagnostic(`seed ${SEED}, ${all.length} inputs x ${Object.keys(CHECKS).length} checks; slowest ms per check: ${JSON.stringify(worst)}`)
  assert.deepStrictEqual(thrown.slice(0, 20), [], 'a check threw')
  assert.deepStrictEqual(slow.slice(0, 20), [], `a check took longer than ${LIMIT_MS} ms`)
})

// Every check is linear, so 1 MB (far beyond any real command) takes a fraction of a second.
// A super-linear pattern takes minutes at this size, so a two second limit separates the two
// clearly even on a slow CI runner (the coverage job, which instruments every line, sets more).
// Each check also runs at 1/8 of the size: when the time grows much faster than the input, that
// is reported too, before it gets anywhere near the limit.
const LONG_LIMIT_MS = Number(process.env.FUZZ_LONG_LIMIT_MS) || 2000

test('fuzz: 1 MB inputs never throw and finish in time', { timeout: 900000 }, async t => {
  const worst = {}
  const slowest = []
  for (const [shape, make] of Object.entries(LONG)) {
    const c = make(MB)
    const small = make(MB / 8)
    for (const [name, fn] of Object.entries(CHECKS)) {
      const { ms, error } = await timedBest(fn, c)
      const smallRun = await timedBest(fn, small)
      if (ms > (worst[name] || { ms: -1 }).ms) worst[name] = { ms: Math.round(ms), shape }
      slowest.push({ ms, name, shape })
      await t.test(`${name} on ${shape} (${c.length} chars)`, async () => {
        assert.strictEqual(error, null, `${name} threw on ${shape}`)
        assert.ok(ms <= LONG_LIMIT_MS, `${name} took ${Math.round(ms)} ms on ${shape} (${c.length} chars), limit ${LONG_LIMIT_MS} ms`)
        // 8 times the input may take 8 times as long, plus noise and garbage collection; quadratic takes 64 times.
        // Under 250 ms for 1 MB is fast whatever the ratio, and tiny small-run times make the ratio noisy.
        if (ms <= Math.max(250, 32 * smallRun.ms)) return
        // Two timings are not enough on a small macOS runner: other test files run at the same
        // time, and one 1 MB run that lands on a busy moment or a major GC reads 30-40 times the
        // 1/8 run (7 ms -> 272 ms) although the same shape measured on that runner grows by about 2
        // per doubling up to 2 MB. So a high ratio is checked again by the growth across four
        // sizes: each doubling of the input should about double the time, where quadratic code
        // takes four times as long every time.
        const fit = await growth(fn, make)
        assert.ok(fit.least < 2.8, `${name} on ${shape} grows faster than linear: at least ${fit.least.toFixed(1)}x per doubling, time ~ size^${fit.slope.toFixed(2)} (${fit.text}); ` +
          `first check: ${Math.round(smallRun.ms)} ms at 1/8 size, ${Math.round(ms)} ms at full size`)
      })
    }
  }
  slowest.sort((a, b) => b.ms - a.ms)
  t.diagnostic(`slowest 1 MB case per check: ${JSON.stringify(worst)}`)
  t.diagnostic(`slowest 5 overall: ${slowest.slice(0, 5).map(x => `${x.name} on ${x.shape} ${Math.round(x.ms)} ms`).join('; ')}`)
})

test('fuzz: hook scripts exit 0 or 2 without a stack trace', { timeout: 600000 }, async t => {
  const r = rng(SEED + 1)
  const cmds = inputs()
  const sample = []
  for (let i = 0; i < 20; i++) sample.push(cmds[Math.floor(r() * COUNT)])
  // 1 MB payloads on stdin
  for (const shape of ['letters', 'double quotes', 'sleep chain', 'one long heredoc', 'NULs', 'unterminated heredocs', 'bash -c nesting', 'ps grep pipes', 'subshell opens']) sample.push(LONG[shape](MB))
  const raw = [
    '', 'not json', '{', '[]', 'null', '"str"', '42', '{"tool_input":null}', '{"tool_input":{"command":123}}',
    '{"tool_input":{"command":["pkill","node"]}}', '{"tool_input":{"command":{"x":1}}}', '{"tool_input":{"command":"pkill node","timeout":"x"}}',
    '{"tool_input":{"command":"sleep 999","timeout":-5}}', '{"cwd":123,"session_id":{},"tool_input":{"command":"git checkout main"}}',
    Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x22]),
  ]
  const tmp = H.realTemp('bulkhead-fuzz-')
  const stateDir = path.join(tmp, 'state')
  const configDir = path.join(tmp, 'config')
  const cwd = path.join(tmp, 'repo')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(configDir, { recursive: true })
  const mock = { listening: true, self: 900200, sessionFiles: [[process.pid, { cwd, startedAt: 0, sessionId: 'other' }]], snapshot: snap }
  const jobs = []
  for (const guard of H.GUARDS) {
    for (const c of sample) jobs.push(() => H.runHook(guard, H.payload(c, { cwd, timeout: 600000 }), { cwd, mock, stateDir, configDir }).then(res => ({ guard, c, res })))
    for (const c of raw) jobs.push(() => H.runHook(guard, c, { cwd, mock, stateDir, configDir }).then(res => ({ guard, c, res })))
  }
  const results = await H.pool(jobs)
  fs.rmSync(tmp, { recursive: true, force: true })
  const bad = results.filter(x => !(x.res.status === 0 || x.res.status === 2) || H.CRASH.test(x.res.stderr) || H.CRASH.test(x.res.stdout))
  const slowest = results.reduce((a, b) => (b.res.ms > a.res.ms ? b : a))
  t.diagnostic(`${results.length} hook runs; slowest ${slowest.guard} ${slowest.res.ms} ms on ${String(slowest.c).length} chars`)
  assert.deepStrictEqual(bad.map(x => `${x.guard} exit ${x.res.status}: ${String(x.res.stderr).slice(0, 200)} <- ${JSON.stringify(String(x.c).slice(0, 60))}`), [])
})
