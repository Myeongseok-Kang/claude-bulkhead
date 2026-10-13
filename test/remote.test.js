'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { tempDir } = require('./helpers')
const { findGitBash } = require('../src/slot-cli')
const remote = require('../src/remote')
const remotes = require('../src/remotes')
const sh = require('../src/remote-sh')
const config = require('../src/config')
const { notice } = require('../src/config-check')
const memoryGuard = require('../src/memory-guard')
const doctor = require('../src/doctor')

// These tests run the real remote side: test/fake-ssh.js stands in for ssh and starts the
// remote shell on this machine, in a temporary "remote" folder. Every path has a space in it.

const BIN = path.join(__dirname, '..', 'bin', 'bulkhead')
const FAKE = path.join(__dirname, 'fake-ssh.js')
const BASH = process.platform === 'win32' ? findGitBash() : 'bash'
const skip = BASH ? false : 'Git Bash is not installed, and the remote side needs bash'
const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

// A repository, a state dir whose config.json names one remote, and the remote's folder.
function world({ host = 'dev@box', shell = BASH, copies = 2, maxJobs = 4, extra = {} } = {}) {
  const root = path.join(tempDir(), 'has space')
  const name = `app ${Math.random().toString(36).slice(2, 8)}`
  const repo = path.join(root, name)
  const state = path.join(root, 'state')
  const dir = path.join(root, 'remote dir')
  fs.mkdirSync(path.join(repo, 'sub dir'), { recursive: true })
  fs.mkdirSync(state)
  git(repo, 'init', '-q')
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n.env\nout\n')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'bye\n')
  fs.writeFileSync(path.join(repo, 'sub dir', 'b.txt'), 'bee\n')
  fs.writeFileSync(path.join(repo, 'serve.js'), [
    "const { spawn } = require('child_process')",
    "spawn(process.execPath, ['-e', 'require(\"net\").createServer().listen(Number(process.env.BULKHEAD_PORT))'], { detached: true, stdio: 'ignore' }).unref()",
  ].join('\n') + '\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ remotes: { box: { host, shell, dir, copies, maxJobs, ...extra } } }, null, 2))
  const env = { ...process.env, ...GIT_ENV, BULKHEAD_STATE_DIR: state, BULKHEAD_SSH: JSON.stringify([process.execPath, FAKE]), BULKHEAD_REMOTE_POLL: '1', BULKHEAD_DISABLE: '' }
  delete env.CLAUDE_PROJECT_DIR
  const project = remote.projectFor(remote.repoInfo(repo))
  return { root, repo, state, dir, env, project, copy: l => path.join(dir, l === 'a' ? project : `${project}-${l}`) }
}

function bulkhead(w, args, { cwd = w.repo } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: w.env, encoding: 'utf8', timeout: 180000 })
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr }
}

// A run in the background, with its output so far and a promise of the end.
function start(w, args, { cwd = w.repo } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: w.env })
  const run = { child, out: '', err: '' }
  child.stdout.on('data', d => (run.out += d))
  child.stderr.on('data', d => (run.err += d))
  run.done = new Promise(resolve => child.on('close', code => resolve({ code, out: run.out, err: run.err, all: run.out + run.err })))
  return run
}

async function until(fn, ms = 30000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 150))
  }
  assert.fail(`timed out waiting for ${what}`)
}

// a remote command that holds its copy until the test calls open(), so a slow machine cannot end it early
function gate(w, name = 'go') {
  const file = path.join(w.root, name)
  return { cmd: `while [ ! -e '${file.replace(/\\/g, '/')}' ]; do sleep 0.2; done`, open: () => fs.writeFileSync(file, '') }
}

const portOf = text => Number((/ port (\d+)/.exec(text) || [])[1])
const copyOf = text => (/ copy ([a-h]) /.exec(text) || [])[1]

function listening(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

test('first run creates copy a; exit code, port and copy pass through', { skip }, () => {
  const w = world()
  const r = bulkhead(w, ['remote', 'run', '--', 'echo "port=$BULKHEAD_PORT copy=$BULKHEAD_COPY"; cat a.txt; exit 7'])
  assert.strictEqual(r.code, 7, r.all)
  assert.match(r.err, /sent [0-9a-f]{7} \(full history/)
  assert.match(r.err, /box {2}copy a {2}.*remote dir.* {2}port \d+/)
  const port = portOf(r.err)
  assert.ok(port >= sh.PORT_BASE && port < sh.PORT_BASE + sh.PORT_BLOCKS * 8 && (port - sh.PORT_BASE) % 8 === 0, `port ${port}`)
  assert.match(r.out, new RegExp(`port=${port} copy=a`))
  assert.match(r.out, /one/)
  assert.match(r.err, /exit 7 after/)
  assert.ok(fs.existsSync(path.join(w.copy('a'), '.git')))
  // locks and the upload are gone
  assert.deepStrictEqual(fs.readdirSync(w.dir).filter(n => n.startsWith('lock-')), [])
  assert.deepStrictEqual(fs.readdirSync(path.join(w.dir, 'jobs')), [])
  assert.deepStrictEqual(fs.existsSync(path.join(w.dir, '.incoming')) ? fs.readdirSync(path.join(w.dir, '.incoming')) : [], [])
})

test('a known HEAD sends nothing; new commits go as an incremental bundle', { skip }, () => {
  const w = world()
  assert.strictEqual(bulkhead(w, ['remote', 'run', '--', 'true']).code, 0)
  const again = bulkhead(w, ['remote', 'run', '--', 'true'])
  assert.match(again.err, /already there, no uncommitted changes/)
  fs.writeFileSync(path.join(w.repo, 'a.txt'), 'two\n')
  git(w.repo, 'commit', '-qam', 'second')
  const inc = bulkhead(w, ['remote', 'run', '--', 'cat a.txt; git log --oneline | wc -l'])
  assert.strictEqual(inc.code, 0, inc.all)
  assert.match(inc.err, /sent [0-9a-f]{7} \(new commits/)
  assert.match(inc.out, /two/)
  assert.match(inc.out, /^\s*2\s*$/m)
})

test('uncommitted changes, untracked files and deletions arrive; ignored files only with --files', { skip }, () => {
  const w = world()
  fs.writeFileSync(path.join(w.repo, 'a.txt'), 'changed\n')
  fs.writeFileSync(path.join(w.repo, 'new file.txt'), 'fresh\n')
  fs.writeFileSync(path.join(w.repo, 'staged.txt'), 'staged\n')
  git(w.repo, 'add', 'staged.txt')
  fs.unlinkSync(path.join(w.repo, 'gone.txt'))
  fs.writeFileSync(path.join(w.repo, '.env'), 'SECRET=1\n')
  const show = 'cat a.txt "new file.txt" staged.txt; ls; test -e .env && echo HAS_ENV; true'
  const r = bulkhead(w, ['remote', 'run', '--', show])
  assert.strictEqual(r.code, 0, r.all)
  assert.match(r.err, /3 changed files \(\d+ B\), 1 deleted/)
  assert.match(r.out, /changed[\s\S]*fresh[\s\S]*staged/)
  assert.doesNotMatch(r.out, /gone\.txt/)
  assert.doesNotMatch(r.out, /HAS_ENV/)
  const withEnv = bulkhead(w, ['remote', 'run', '--files=.env', '--', show])
  assert.match(withEnv.out, /HAS_ENV/)
  assert.match(withEnv.err, /also sent, though git may ignore them: \.env/)
  // the next run without --files cleans untracked files but keeps ignored ones such as .env
  fs.unlinkSync(path.join(w.repo, 'new file.txt'))
  const next = bulkhead(w, ['remote', 'run', '--', 'ls; test -e .env && echo HAS_ENV; true'])
  assert.doesNotMatch(next.out, /new file/)
  assert.match(next.out, /HAS_ENV/)
})

test('--files outside the repository or inside .git is refused', { skip }, () => {
  const w = world()
  assert.match(bulkhead(w, ['remote', 'run', '--files=../state', '--', 'true']).err, /not inside the repository/)
  assert.match(bulkhead(w, ['remote', 'run', '--files=.git', '--', 'true']).err, /inside \.git/)
  assert.match(bulkhead(w, ['remote', 'run', '--files=nope', '--', 'true']).err, /does not exist/)
})

test('npm ci runs as npm install, since the copies share node_modules', { skip }, () => {
  assert.deepStrictEqual(remote.rewriteNpmCi('npm ci && npm test'), { command: 'npm install --no-audit --no-fund && npm test', changed: true })
  assert.strictEqual(remote.rewriteNpmCi('cd web; npm ci --ignore-scripts').command, 'cd web; npm install --no-audit --no-fund --ignore-scripts')
  assert.strictEqual(remote.rewriteNpmCi('npm clean-install').command, 'npm install --no-audit --no-fund')
  for (const same of ['pnpm ci', 'npm cit', 'npm install', 'npm run ci', 'npm test']) assert.strictEqual(remote.rewriteNpmCi(same).changed, false, same)
  const w = world()
  const r = bulkhead(w, ['remote', 'run', '--', 'echo npm ci --omit=dev'])
  assert.match(r.out, /npm install --no-audit --no-fund --omit=dev/)
  assert.match(r.err, /npm ci runs as npm install/)
})

test('parallel runs take different copies and ports, and share node_modules', { skip }, async () => {
  const w = world()
  // copy a gets a node_modules folder (ignored, so it survives the next checkout)
  assert.strictEqual(bulkhead(w, ['remote', 'run', '--', 'mkdir -p node_modules/pkg && echo shared > node_modules/pkg/index.js']).code, 0)
  const g = gate(w)
  const first = start(w, ['remote', 'run', '--', `echo first; ${g.cmd}`])
  await until(() => / copy a /.test(first.err), 30000, 'the first run to start')
  const second = bulkhead(w, ['remote', 'run', '--', 'echo "copy=$BULKHEAD_COPY"; cat node_modules/pkg/index.js'])
  g.open()
  const one = await first.done
  assert.strictEqual(one.code, 0, one.all)
  assert.strictEqual(second.code, 0, second.all)
  assert.strictEqual(copyOf(second.err), 'b')
  assert.strictEqual(portOf(second.err), portOf(one.err) + 1)
  assert.match(second.out, /copy=b[\s\S]*shared/)
  assert.ok(fs.lstatSync(path.join(w.copy('b'), 'node_modules')).isSymbolicLink(), 'node_modules in copy b links to copy a')
})

test('no free copy: --wait=0 exits 3 and names the holder; a longer wait gets the copy', { skip }, async () => {
  const w = world({ copies: 1 })
  const g = gate(w)
  const holder = start(w, ['remote', 'run', '--label=long job', '--', g.cmd])
  await until(() => / copy a /.test(holder.err), 30000, 'the holder to start')
  const r = bulkhead(w, ['remote', 'run', '--wait=0', '--', 'true'])
  assert.strictEqual(r.code, 3, r.all)
  assert.match(r.err, /the only copy of .* is in use/)
  assert.match(r.err, /lock-.*-a \d+s from .*: long job/)
  const waiting = start(w, ['remote', 'run', '--wait=1', '--', 'echo got it'])
  await until(() => /waiting: the only copy/.test(waiting.err), 30000, 'the second run to wait')
  g.open()
  const waited = await waiting.done
  assert.strictEqual(waited.code, 0, waited.all)
  assert.match(waited.err, /waiting: the only copy/)
  assert.match(waited.out, /got it/)
  assert.strictEqual((await holder.done).code, 0)
})

test('maxJobs and minFreeGb hold a job back the same way', { skip }, async () => {
  const w = world({ maxJobs: 1 })
  const g = gate(w)
  const holder = start(w, ['remote', 'run', '--', g.cmd])
  await until(() => / copy a /.test(holder.err), 30000, 'the holder to start')
  const r = bulkhead(w, ['remote', 'run', '--wait=0', '--', 'true'])
  g.open()
  assert.strictEqual(r.code, 3, r.all)
  assert.match(r.err, /the only job slot on this machine is taken/)
  await holder.done
  const big = world({ extra: { minFreeGb: 100000 } })
  const low = bulkhead(big, ['remote', 'run', '--wait=0', '--gb=2', '--', 'true'])
  assert.strictEqual(low.code, 3, low.all)
  assert.match(low.err, /free RAM [\d.]+ GB - this job 2\.0 GB is below the 100000\.0 GB minimum/)
})

test('stale locks are removed: an old one without info, and one whose process is gone', { skip }, () => {
  const w = world({ copies: 1 })
  fs.mkdirSync(w.dir, { recursive: true })
  const old = path.join(w.dir, `lock-${w.project}-a`)
  fs.mkdirSync(old)
  const t = Date.now() / 1000 - 7 * 3600
  fs.utimesSync(old, t, t)
  const r = bulkhead(w, ['remote', 'run', '--', 'true'])
  assert.strictEqual(r.code, 0, r.all)
  assert.match(r.err, /removed a stale lock, lock-.*-a: (?:no sign of life for 6 hours|it was taken before the last reboot)/)
  fs.mkdirSync(path.join(w.dir, 'jobs', 'job-1'), { recursive: true })
  fs.writeFileSync(path.join(w.dir, 'jobs', 'job-1', 'info'), `pid=2147480\nstarted=${Math.floor(Date.now() / 1000)}\ngb=0\nfrom=x\nlabel=ghost\n`)
  const again = bulkhead(w, ['remote', 'run', '--', 'true'])
  assert.strictEqual(again.code, 0, again.all)
  assert.match(again.err, /removed a stale lock, job-1: its process 2147480 is gone/)
})

test('a server left listening on BULKHEAD_PORT is stopped after the command', { skip }, async () => {
  const w = world()
  const r = bulkhead(w, ['remote', 'run', '--', 'node serve.js; sleep 2'])
  assert.strictEqual(r.code, 0, r.all)
  const port = portOf(r.err)
  assert.match(r.err, new RegExp('stopped pid \\d+.*BULKHEAD_PORT'))
  assert.strictEqual(await listening(port), false, `port ${port} is still open`)
})

test('an unreachable remote exits 5; a remote whose shell does not start too', { skip }, () => {
  const down = world({ host: 'unreachable-box' })
  const r = bulkhead(down, ['remote', 'run', '--', 'true'])
  assert.strictEqual(r.code, 5, r.all)
  assert.match(r.err, /cannot reach box \(unreachable-box\): ssh could not connect to unreachable-box: .*Connection refused/)
  const noShell = world({ shell: 'no-such-shell-here' })
  const s = bulkhead(noShell, ['remote', 'run', '--', 'true'])
  assert.strictEqual(s.code, 5, s.all)
  assert.match(s.err, /`no-such-shell-here -s` did not run/)
})

test('--tail keeps the full output in a log and prints only the last lines', { skip }, () => {
  const w = world()
  const r = bulkhead(w, ['remote', 'run', '--tail=3', '--', 'i=1; while [ $i -le 100 ]; do echo "line $i"; i=$((i + 1)); done'])
  assert.strictEqual(r.code, 0, r.all)
  assert.deepStrictEqual(r.out.trim().split(/\r?\n/), ['line 98', 'line 99', 'line 100'])
  const log = /full log: (.+\.log)/.exec(r.err)[1]
  const text = fs.readFileSync(log, 'utf8')
  assert.match(text, /^line 1$/m)
  assert.match(text, /^line 100$/m)
  assert.match(text, /\[bulkhead remote\] box {2}copy a/)
  assert.ok(log.startsWith(path.join(w.state, 'remote-logs')))
})

test('old logs are pruned to the newest 50', () => {
  const dir = tempDir()
  for (let i = 0; i < 55; i++) fs.writeFileSync(path.join(dir, `20260101-0000${String(i).padStart(2, '0')}-p.log`), '')
  remote.pruneLogs(dir)
  const left = fs.readdirSync(dir)
  assert.strictEqual(left.length, 50)
  assert.ok(!left.includes('20260101-000000-p.log'))
})

test('a lost connection stops the remote job and frees its copy', { skip }, async () => {
  const w = world({ copies: 1 })
  const job = 'node -e "require(\'fs\').writeFileSync(\'job.pid\', String(process.pid)); console.log(\'started\'); setInterval(() => {}, 1000)"'
  const run = start(w, ['remote', 'run', '--', job])
  await until(() => /started/.test(run.out), 30000, 'the job to start')
  const pid = Number(fs.readFileSync(path.join(w.copy('a'), 'job.pid'), 'utf8'))
  assert.ok(alive(pid))
  run.child.kill('SIGKILL')
  await until(() => !fs.existsSync(path.join(w.dir, `lock-${w.project}-a`)) && !fs.existsSync(path.join(w.dir, 'jobs', 'job-1')), 30000, 'the locks to be freed')
  await until(() => !alive(pid), 15000, `job pid ${pid} to stop`)
  // the copy is free for the next run
  assert.strictEqual(bulkhead(w, ['remote', 'run', '--wait=0', '--', 'true']).code, 0)
})

test('a run from a subfolder runs there; fetch and --fetch copy results back', { skip }, () => {
  const w = world()
  const sub = path.join(w.repo, 'sub dir')
  const r = bulkhead(w, ['remote', 'run', '--fetch=out', '--', 'cat b.txt; mkdir -p "out/deep dir"; echo result > "out/deep dir/r.txt"'], { cwd: sub })
  assert.strictEqual(r.code, 0, r.all)
  assert.match(r.out, /bee/)
  assert.match(r.err, /fetched out/)
  assert.strictEqual(fs.readFileSync(path.join(sub, 'out', 'deep dir', 'r.txt'), 'utf8').trim(), 'result')
  const f = bulkhead(w, ['remote', 'fetch', 'out/deep dir', 'got here'], { cwd: sub })
  assert.strictEqual(f.code, 0, f.all)
  assert.strictEqual(fs.readFileSync(path.join(sub, 'got here', 'deep dir', 'r.txt'), 'utf8').trim(), 'result')
  const missing = bulkhead(w, ['remote', 'fetch', 'nothing-here'], { cwd: sub })
  assert.strictEqual(missing.code, 1, missing.all)
  assert.match(missing.err, /nothing-here does not exist in copy a/)
  assert.strictEqual(bulkhead(w, ['remote', 'fetch', '../escape']).code, 2)
  assert.match(bulkhead(w, ['remote', 'fetch', 'out', '--bogus']).err, /unknown option --bogus/)
  // outside the repository, --project names the copies
  const outside = bulkhead(w, ['remote', 'fetch', 'out'], { cwd: w.state })
  assert.strictEqual(outside.code, 2, outside.all)
  assert.match(outside.err, /run fetch inside the repository, or name its copies with --project/)
  const named = bulkhead(w, ['remote', 'fetch', 'sub dir/out/deep dir', 'by name', `--project=${w.project}`], { cwd: w.state })
  assert.strictEqual(named.code, 0, named.all)
  assert.ok(fs.existsSync(path.join(w.state, 'by name', 'deep dir', 'r.txt')))
})

test('status lists held jobs and copies; --json too', { skip }, async () => {
  const w = world()
  const g = gate(w)
  const holder = start(w, ['remote', 'run', '--label=e2e suite', '--gb=2', '--', g.cmd])
  await until(() => / copy a /.test(holder.err), 30000, 'the holder to start')
  const r = bulkhead(w, ['remote', 'status'])
  const j = JSON.parse(bulkhead(w, ['remote', 'status', '--json']).out)
  g.open()
  assert.strictEqual(r.code, 0, r.all)
  assert.match(r.out, /box {2}dev@box {2}reachable/)
  assert.match(r.out, /job-1 .* 2 .*e2e suite/)
  assert.strictEqual(j.remotes[0].reachable, true)
  assert.ok(j.remotes[0].locks.some(l => l.lock === `lock-${w.project}-a` && l.label === 'e2e suite' && l.gb === 2))
  assert.ok(j.remotes[0].copies.includes(w.project))
  await holder.done
  const down = world({ host: 'unreachable-box' })
  assert.strictEqual(bulkhead(down, ['remote', 'status']).code, 5)
})

test('remote add, list and remove keep the other keys of the global file', () => {
  const state = tempDir()
  const file = path.join(state, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ killGuard: { allowNames: ['ffmpeg'] }, waitGuard: { limitSeconds: 300 } }, null, 2))
  const env = { ...process.env, BULKHEAD_STATE_DIR: state }
  const run = args => {
    const r = spawnSync(process.execPath, [BIN, 'remote', ...args], { env, encoding: 'utf8', cwd: state })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  const add = run(['add', 'buildbox', 'dev@192.168.1.20', '--ssh-option=IdentityFile=~/.ssh/buildbox', '--ssh-option', 'Port=2222', '--copies=3', '--no-check'])
  assert.strictEqual(add.code, 0, add.err)
  assert.match(add.out, /added remote buildbox/)
  let obj = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepStrictEqual(Object.keys(obj), ['killGuard', 'waitGuard', 'remotes'])
  assert.deepStrictEqual(obj.remotes.buildbox, { host: 'dev@192.168.1.20', copies: 3, sshOptions: ['IdentityFile=~/.ssh/buildbox', 'Port=2222'] })
  assert.strictEqual(run(['add', 'gpu', 'dev@gpu', '--default', '--no-check']).code, 0)
  const list = run(['list'])
  assert.match(list.out, /buildbox +dev@192\.168\.1\.20 +bash +~\/bulkhead-remote +3 +4 +- +IdentityFile=~\/\.ssh\/buildbox Port=2222/)
  assert.match(list.out, /gpu \*/)
  assert.strictEqual(run(['add', 'bad', '-oProxyCommand=x', '--no-check']).code, 2)
  assert.strictEqual(run(['add', 'bad', 'dev@x', '--copies=9', '--no-check']).code, 2)
  assert.strictEqual(run(['remove', 'gpu']).code, 0)
  obj = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.strictEqual(obj.remote, undefined, 'remote.default went with the remote')
  assert.deepStrictEqual(Object.keys(obj.remotes), ['buildbox'])
  assert.strictEqual(run(['remove', 'gpu']).code, 2)
  assert.strictEqual(run(['remove', 'buildbox']).code, 0)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { killGuard: { allowNames: ['ffmpeg'] }, waitGuard: { limitSeconds: 300 } })
  // a broken file is never overwritten
  fs.writeFileSync(file, '{ "killGuard": ')
  const broken = run(['add', 'x', 'dev@x', '--no-check'])
  assert.strictEqual(broken.code, 2)
  assert.match(broken.err, /not valid JSON/)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ "killGuard": ')
})

test('with several remotes, run needs --remote or remote.default', () => {
  const cfg = { values: { remotes: { a: { name: 'a' }, b: { name: 'b' } }, 'remote.default': null }, warnings: [] }
  assert.throws(() => remote.pickRemote(cfg), /2 remotes are configured \(a, b\); pick one with --remote=NAME/)
  assert.strictEqual(remote.pickRemote(cfg, 'b').name, 'b')
  assert.throws(() => remote.pickRemote(cfg, 'c'), /no remote named "c"/)
  assert.strictEqual(remote.pickRemote({ ...cfg, values: { ...cfg.values, 'remote.default': 'a' } }).name, 'a')
  assert.throws(() => remote.pickRemote({ ...cfg, values: { ...cfg.values, 'remote.default': 'gone' } }), /remote.default is "gone", which is not configured/)
  assert.throws(() => remote.pickRemote({ values: { remotes: {} }, warnings: [] }), /no remote is configured/)
})

test('a project config cannot define remotes', () => {
  const state = tempDir()
  const repo = tempDir()
  fs.mkdirSync(path.join(repo, '.git'))
  fs.mkdirSync(path.join(repo, '.claude'))
  fs.writeFileSync(path.join(repo, '.claude', 'bulkhead.json'), JSON.stringify({ remotes: { evil: { host: 'x@evil.example', sshOptions: ['ProxyCommand=sh -c id'] } }, remote: { default: 'evil' } }))
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ remotes: { box: { host: 'dev@box' } } }))
  const cfg = config.load({ env: { BULKHEAD_STATE_DIR: state }, cwd: repo })
  assert.deepStrictEqual(Object.keys(cfg.values.remotes), ['box'])
  assert.strictEqual(cfg.values['remote.default'], null)
  assert.ok(cfg.warnings.some(w => /"remotes" can only be set in the global config file/.test(w)))
  assert.ok(cfg.warnings.some(w => /"remote\.default" can only be set in the global config file/.test(w)))
})

test('config check reports bad remote entries and keeps the good ones', () => {
  const state = tempDir()
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    remotes: {
      good: { host: 'dev@192.168.1.20', dir: 'C:/bulkhead-remote', shell: 'C:\\Program Files\\Git\\bin\\bash.exe', sshOptions: ['HostKeyAlias=good'] },
      flag: { host: '-oProxyCommand=sh' },
      copies: { host: 'dev@x', copies: 0 },
      opts: { host: 'dev@x', sshOptions: ['-i ~/.ssh/key'] },
      typo: { host: 'dev@x', maxjobs: 2 },
      nohost: { dir: '/tmp' },
      'bad name': { host: 'dev@x' },
    },
  }))
  const cfg = config.load({ env: { BULKHEAD_STATE_DIR: state }, cwd: state })
  assert.deepStrictEqual(Object.keys(cfg.values.remotes), ['good'])
  assert.deepStrictEqual(cfg.values.remotes.good, { name: 'good', host: 'dev@192.168.1.20', shell: 'C:\\Program Files\\Git\\bin\\bash.exe', dir: 'C:/bulkhead-remote', copies: 4, maxJobs: 4, minFreeGb: 0, sshOptions: ['HostKeyAlias=good'] })
  const text = cfg.warnings.join('\n')
  assert.match(text, /"remotes\.flag\.host" should be user@host/)
  assert.match(text, /"remotes\.copies\.copies" should be a whole number from 1 to 8/)
  assert.match(text, /"remotes\.opts\.sshOptions" should be a list of ssh -o options/)
  assert.match(text, /unknown key "remotes\.typo\.maxjobs"/)
  assert.match(text, /remotes\.nohost\.host is missing/)
  assert.match(text, /"bad name" is not a valid name/)
  assert.match(notice(cfg), /config problem/)
  const wrongType = tempDir()
  fs.writeFileSync(path.join(wrongType, 'config.json'), JSON.stringify({ remotes: ['dev@x'] }))
  assert.match(config.load({ env: { BULKHEAD_STATE_DIR: wrongType }, cwd: wrongType }).warnings.join(), /"remotes" should be an object/)
})

test('ssh gets the fixed options, the remote options and the quoted shell', () => {
  const r = remotes.normalize('box', { host: 'dev@box', shell: 'C:\\Program Files\\Git\\bin\\bash.exe', sshOptions: ['IdentityFile=~/.ssh/k', 'Port=2222'] }).remote
  const args = remote.sshArgs(r, ['ssh'])
  assert.deepStrictEqual(args.slice(-6), ['-o', 'IdentityFile=~/.ssh/k', '-o', 'Port=2222', 'dev@box', '"C:\\Program Files\\Git\\bin\\bash.exe" -s'])
  for (const o of ['BatchMode=yes', 'ConnectTimeout=10', 'ServerAliveInterval=30', 'ServerAliveCountMax=6', 'LogLevel=ERROR']) assert.ok(args.includes(o), o)
  assert.strictEqual(remote.remoteShell('bash'), 'bash')
  assert.strictEqual(remote.remoteShell('"C:\\Program Files\\Git\\bin\\bash.exe"'), '"C:\\Program Files\\Git\\bin\\bash.exe"')
  assert.deepStrictEqual(remote.sshCommand({ BULKHEAD_SSH: '["node", "fake.js"]' }), ['node', 'fake.js'])
  assert.throws(() => remote.sshCommand({ BULKHEAD_SSH: 'ssh -v' }), /JSON array/)
})

test('the command line: one argument as typed, several quoted back', () => {
  assert.strictEqual(remote.commandLine(['npm test && echo ok']), 'npm test && echo ok')
  assert.strictEqual(remote.commandLine(['bash', '-c', 'echo "a b" && ls']), `bash -c 'echo "a b" && ls'`)
  assert.strictEqual(remote.commandLine(['echo', "it's"]), `echo 'it'\\''s'`)
})

test('project names are safe folder names; ports start from a stable hash', () => {
  assert.strictEqual(remote.projectFor({ name: 'web', id: '0a1b2c' }), 'web-0a1b2c')
  assert.strictEqual(remote.projectFor({ name: 'web', id: '0a1b2c' }, 'acme web'), 'acme-web')
  assert.throws(() => remote.projectFor({ name: 'web', id: '0a1b2c' }, 'web-b'), /ending in -a to -h/)
  assert.strictEqual(remote.projectName('acme web'), 'acme-web')
  assert.strictEqual(remote.projectName('../x'), 'x')
  assert.strictEqual(remote.projectName('...'), 'project')
  assert.strictEqual(sh.hash('acme-web'), sh.hash('acme-web'))
  assert.notStrictEqual(sh.hash('acme-web') % 100, sh.hash('acme-api') % 100)
})

test('a Windows checkout sends the executable bit git records', { skip }, () => {
  const w = world()
  fs.writeFileSync(path.join(w.repo, 'run.sh'), 'echo run\n')
  git(w.repo, 'add', 'run.sh')
  git(w.repo, 'update-index', '--chmod=+x', 'run.sh')
  git(w.repo, 'commit', '-qm', 'script')
  fs.writeFileSync(path.join(w.repo, 'run.sh'), 'echo changed\n')
  const c = remote.localChanges(w.repo, 'win32')
  assert.deepStrictEqual(c.changed, ['run.sh'])
  assert.deepStrictEqual(c.executable, ['run.sh'])
  assert.deepStrictEqual(remote.localChanges(w.repo, 'linux').executable, [])
})

test('only commits this repository has are left out of a bundle', { skip }, () => {
  const w = world()
  const head = git(w.repo, 'rev-parse', 'HEAD').trim()
  assert.deepStrictEqual(remote.knownCommits(w.repo, [head, 'f'.repeat(40), '--output=x', `${head}^`]), [head])
})

test('memory-guard offers bulkhead remote run only when a remote is configured', () => {
  const low = () => ({ freeGb: 1.2, totalGb: 32 })
  assert.match(memoryGuard.check('npm test', low, 3, 'sh', () => true), /bulkhead remote run -- <command>/)
  const without = memoryGuard.check('npm test', low, 3, 'sh', () => false)
  assert.match(without, /bulkhead-slot run/)
  assert.doesNotMatch(without, /remote/)
  assert.strictEqual(memoryGuard.check('bulkhead remote run --gb=4 -- npx playwright test', low, 3, 'sh', () => true), null)
})

test('doctor checks each configured remote, and nothing when there is none', () => {
  const cfg = { values: { remotes: {} } }
  assert.deepStrictEqual(doctor.checkRemotes(cfg), [])
  const box = remotes.normalize('box', { host: 'dev@box' }).remote
  const env = { ...process.env, BULKHEAD_SSH: '["ssh"]' }
  const good = doctor.checkRemotes({ values: { remotes: { box } } }, { env, probe: () => ({ ok: true, ms: 300, bash: '5.2.21(1)-release', git: 'git version 2.43.0', tar: 'yes', dir: '/home/dev/bulkhead-remote', writable: 'yes', mem: { freeGb: 12.3, totalGb: 31.8 } }) })
  const line = good.find(c => c.id === 'remote box')
  assert.strictEqual(line.status, 'OK')
  assert.strictEqual(line.summary, 'dev@box reachable in 0.3s, bash 5.2.21, git 2.43.0, tar, /home/dev/bulkhead-remote writable, 12.3 of 31.8 GB free')
  const noGit = doctor.checkRemotes({ values: { remotes: { box } } }, { env, probe: () => ({ ok: true, ms: 300, git: 'none', tar: 'yes', writable: 'yes' }) })
  assert.match(noGit.find(c => c.id === 'remote box').summary, /missing on the remote: git/)
  const down = doctor.checkRemotes({ values: { remotes: { box } } }, { env, probe: () => ({ ok: false, error: 'ssh could not connect to dev@box' }) })
  assert.strictEqual(down.find(c => c.id === 'remote box').status, 'FAIL')
})

test('doctor reaches a remote through ssh', { skip }, () => {
  const w = world()
  const r = spawnSync(process.execPath, [BIN, 'doctor', '--json'], { env: w.env, encoding: 'utf8', cwd: w.repo })
  const checks = JSON.parse(r.stdout).checks
  const line = checks.find(c => c.id === 'remote box')
  assert.strictEqual(line.status, 'OK', line.summary)
  assert.match(line.summary, /reachable in .*git .*tar.*writable/)
  const skipped = JSON.parse(spawnSync(process.execPath, [BIN, 'doctor', '--json', '--no-remote'], { env: w.env, encoding: 'utf8', cwd: w.repo }).stdout).checks
  assert.ok(!skipped.some(c => c.id.startsWith('remote')))
})

test('usage errors exit 2 and print what to write instead', () => {
  const env = { ...process.env, BULKHEAD_STATE_DIR: tempDir() }
  const run = args => spawnSync(process.execPath, [BIN, 'remote', ...args], { env, encoding: 'utf8', cwd: tempDir() })
  assert.strictEqual(run(['run', 'npm', 'test']).status, 2)
  assert.match(run(['run', '--bogus', '--', 'x']).stderr, /unknown option --bogus/)
  assert.match(run(['run', '--', 'x']).stderr, /no remote is configured/)
  assert.strictEqual(run(['frobnicate']).status, 2)
  assert.strictEqual(run(['--help']).status, 0)
})

test('two repositories with the same folder name get their own copies; worktrees share them', { skip }, () => {
  const w = world()
  // another repository with the same folder name, somewhere else
  const other = path.join(w.root, 'elsewhere', path.basename(w.repo))
  fs.mkdirSync(other, { recursive: true })
  git(other, 'init', '-q')
  fs.writeFileSync(path.join(other, 'a.txt'), 'other\n')
  git(other, 'add', '-A')
  git(other, 'commit', '-qm', 'other')
  const mine = bulkhead(w, ['remote', 'run', '--', 'cat a.txt'])
  const theirs = bulkhead(w, ['remote', 'run', '--', 'cat a.txt'], { cwd: other })
  assert.strictEqual(mine.code, 0, mine.all)
  assert.strictEqual(theirs.code, 0, theirs.all)
  assert.match(mine.out, /one/)
  assert.match(theirs.out, /other/)
  assert.match(theirs.err, /full history/)
  const base = w.project.slice(0, -7)
  const copies = fs.readdirSync(w.dir).filter(n => n.startsWith(base))
  assert.strictEqual(copies.length, 2, copies.join(', '))
  assert.notStrictEqual(remote.repoInfo(other).id, remote.repoInfo(w.repo).id)
  // a worktree of w's repository uses the same copy, so nothing is sent
  const wt = path.join(w.root, 'wt')
  git(w.repo, 'worktree', 'add', '-q', '--detach', wt)
  const fromWt = bulkhead(w, ['remote', 'run', '--', 'cat a.txt'], { cwd: wt })
  assert.strictEqual(fromWt.code, 0, fromWt.all)
  assert.match(fromWt.err, /already there/)
  assert.ok(fromWt.err.includes(w.project), fromWt.err)
  // the id is kept in the repository's config, so a folder moved elsewhere keeps its copies
  const moved = path.join(w.root, 'moved', path.basename(other))
  fs.mkdirSync(path.dirname(moved))
  fs.renameSync(other, moved)
  const after = bulkhead(w, ['remote', 'run', '--', 'true'], { cwd: moved })
  assert.match(after.err, /already there/)
  // --project is used as given
  const named = bulkhead(w, ['remote', 'run', '--project=shared name', '--', 'true'])
  assert.strictEqual(named.code, 0, named.all)
  assert.ok(fs.existsSync(path.join(w.dir, 'shared-name', '.git')))
  assert.strictEqual(bulkhead(w, ['remote', 'run', '--project=web-c', '--', 'true']).code, 2)
})

test('the repository id: stable, saved in the git config, and per machine and path', () => {
  const dir = tempDir()
  git(dir, 'init', '-q')
  const common = path.join(dir, '.git')
  const a = remote.repoId(common, { host: 'one', store: false })
  assert.match(a, /^[0-9a-f]{6}$/)
  assert.strictEqual(remote.repoId(common, { host: 'one', store: false }), a)
  assert.notStrictEqual(remote.repoId(common, { host: 'two', store: false }), a)
  assert.strictEqual(remote.repoId(common, { host: 'ONE', store: false }), a)
  assert.strictEqual(remote.repoId(common, { host: 'one' }), a)
  assert.strictEqual(git(dir, 'config', 'bulkhead.remoteid').trim(), a)
  // once saved, another machine name no longer changes it
  assert.strictEqual(remote.repoId(common, { host: 'two' }), a)
})

test('macOS boot time is read from sec, not usec', { skip }, () => {
  const script = sh.prelude({ token: 't', dir: '.' }) + 'printf "{ sec = 1700000000, usec = 523000 } Tue Nov 14 22:13:20 2023\\n" | kern_boottime\n'
  const r = spawnSync(BASH, ['-s'], { input: script, encoding: 'utf8' })
  assert.strictEqual(r.stdout.trim(), '1700000000', r.stderr)
})

test('the command runs with SIGPIPE at its default and without the ssh channel on fd 3', { skip }, () => {
  const w = world()
  const r = bulkhead(w, ['remote', 'run', '--', 'yes | head -n 1 >/dev/null; echo "pipe=${PIPESTATUS[0]}"; { true <&3; } 2>/dev/null && echo FD3_OPEN || echo FD3_CLOSED'])
  assert.strictEqual(r.code, 0, r.all)
  assert.match(r.out, /pipe=141/)
  assert.match(r.out, /FD3_CLOSED/)
  assert.doesNotMatch(r.err, /Broken pipe/)
})

test('a connection lost during the upload exits 5 with a message, not a crash', { skip }, () => {
  const w = world()
  w.env.FAKE_SSH_COUNT = path.join(w.root, 'ssh-count')
  w.env.FAKE_SSH_DROP = '2'
  // big enough that tar is still sending when the connection drops
  fs.writeFileSync(path.join(w.repo, 'big.bin'), Buffer.alloc(32 << 20, 1))
  const r = bulkhead(w, ['remote', 'run', '--', 'true'])
  assert.strictEqual(r.code, 5, r.all)
  assert.match(r.err, /sending to box failed/)
  assert.doesNotMatch(r.err, /Unhandled|at .*\.js:\d+/)
})

test('a run that fails after receiving commits leaves no incoming ref behind', { skip }, async () => {
  const w = world()
  assert.strictEqual(bulkhead(w, ['remote', 'run', '--', 'true']).code, 0)
  const g = gate(w)
  const holder = start(w, ['remote', 'run', '--', g.cmd])
  await until(() => / copy a /.test(holder.err), 30000, 'the holder to start')
  // copy b's folder is in the way, so the run fails after it fetched the new commit
  fs.mkdirSync(w.copy('b'))
  fs.writeFileSync(path.join(w.copy('b'), 'junk'), 'x')
  fs.writeFileSync(path.join(w.repo, 'a.txt'), 'two\n')
  git(w.repo, 'commit', '-qam', 'second')
  const r = bulkhead(w, ['remote', 'run', '--wait=0', '--', 'true'])
  g.open()
  await holder.done
  assert.strictEqual(r.code, 4, r.all)
  assert.match(r.err, /exists but is not a copy/)
  assert.doesNotMatch(git(w.copy('a'), 'for-each-ref', 'refs/bulkhead/'), /in-/)
})

test('a copy whose copy a was removed is made again', { skip }, async () => {
  const w = world()
  const g = gate(w)
  const first = start(w, ['remote', 'run', '--', g.cmd])
  await until(() => / copy a /.test(first.err), 30000, 'the first run to start')
  assert.strictEqual(bulkhead(w, ['remote', 'run', '--', 'true']).code, 0)
  g.open()
  await first.done
  assert.ok(fs.existsSync(path.join(w.copy('b'), '.git')))
  fs.rmSync(w.copy('a'), { recursive: true, force: true })
  const r = bulkhead(w, ['remote', 'run', '--', 'echo "copy=$BULKHEAD_COPY"; cat a.txt'])
  assert.strictEqual(r.code, 0, r.all)
  assert.match(r.out, /copy=b[\s\S]*one/)
  assert.match(r.err, /copy b was a worktree of a removed copy a; made it again/)
})

test('a lock is reclaimed by one process at a time; an abandoned reclaim mutex expires', { skip }, () => {
  const w = world({ copies: 1 })
  fs.mkdirSync(path.join(w.dir, 'jobs'), { recursive: true })
  const lock = path.join(w.dir, `lock-${w.project}-a`)
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, 'info'), `pid=2147480\nstarted=${Math.floor(Date.now() / 1000)}\ngb=0\nfrom=x\nlabel=ghost\n`)
  // another process is deciding about this lock right now: leave it to that one
  fs.mkdirSync(`${lock}.reclaim`)
  const busy = bulkhead(w, ['remote', 'run', '--wait=0', '--', 'true'])
  assert.strictEqual(busy.code, 3, busy.all)
  const st = JSON.parse(bulkhead(w, ['remote', 'status', '--json']).out)
  assert.ok(!st.remotes[0].locks.some(l => /reclaim/.test(l.lock)), JSON.stringify(st))
  // a mutex older than 2 minutes was left by a process that died
  const t = Date.now() / 1000 - 300
  fs.utimesSync(`${lock}.reclaim`, t, t)
  const r = bulkhead(w, ['remote', 'run', '--wait=0', '--', 'true'])
  assert.strictEqual(r.code, 0, r.all)
  assert.match(r.err, /removed a stale lock, lock-.*-a: its process 2147480 is gone/)
  assert.ok(!fs.existsSync(`${lock}.reclaim`))
})

test('when every port block is taken, one whose project was removed is reused', { skip }, () => {
  const w = world()
  for (let n = 0; n < sh.PORT_BLOCKS; n++) {
    fs.mkdirSync(path.join(w.dir, 'ports', String(n)), { recursive: true })
    fs.writeFileSync(path.join(w.dir, 'ports', String(n), 'project'), `gone-${n}\n`)
  }
  const r = bulkhead(w, ['remote', 'run', '--', 'true'])
  assert.strictEqual(r.code, 0, r.all)
  const n = (portOf(r.err) - sh.PORT_BASE) / 8
  assert.strictEqual(fs.readFileSync(path.join(w.dir, 'ports', String(n), 'project'), 'utf8').trim(), w.project)
})

test('--files: ..x is inside the repository, .GIT in any case is not, a linked current folder works; tar adds no macOS metadata', () => {
  assert.strictEqual(remote.tarEnv({ PATH: '/bin' }).COPYFILE_DISABLE, '1')
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, '..x'), '')
  assert.deepStrictEqual(remote.extraFiles(['..x'], dir, dir), ['..x'])
  assert.throws(() => remote.extraFiles(['../x'], dir, dir), /not inside/)
  // a case-insensitive remote would unpack .GIT over the copy's .git
  fs.mkdirSync(path.join(dir, '.GIT'))
  assert.throws(() => remote.extraFiles(['.GIT'], dir, dir), /inside \.git/)
  assert.throws(() => remote.extraFiles(['.Git/config'], dir, dir), /inside \.git/)
  // the current folder reached through a link, the repository root as git reports it
  const link = path.join(tempDir(), 'link')
  fs.symlinkSync(dir, link, 'junction')
  assert.deepStrictEqual(remote.extraFiles(['..x'], link, fs.realpathSync.native(dir)), ['..x'])
})

test('a git that cannot run (the macOS stub without the command line tools) counts as missing', { skip }, () => {
  const stub = tempDir()
  fs.writeFileSync(path.join(stub, 'git'), '#!/bin/sh\necho "xcrun: error: invalid active developer path" >&2\nexit 1\n', { mode: 0o755 })
  // set inside the script: Git for Windows' bash.exe puts its own folders first in PATH
  const first = `PATH="$(cd ${sh.q(stub.replace(/\\/g, '/'))} && pwd):$PATH"\n`
  const r = spawnSync(BASH, ['-s'], { input: first + sh.probeScript({ token: 't', dir: path.join(stub, 'remote dir') }), encoding: 'utf8' })
  assert.deepStrictEqual(remote.marks(r.stdout, 't').find(([k]) => k === 'git'), ['git', 'none'], r.stdout + r.stderr)
})
