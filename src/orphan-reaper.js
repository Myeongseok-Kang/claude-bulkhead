'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const { enabled, setting, log, oneLine, recordEvent } = require('./hook')
const { readSessionFiles, claudeDir } = require('./sessions')
const { readProcesses } = require('./processes')

// What the reaper may stop once the Claude session that started it is proven gone. Anything that
// matches none of these is never stopped on its own account. `name` is tested against the program
// name without .exe, `cmd` against the whole command line. Shells are never matched: their command
// line names whatever they run, and they are stopped only as the top of an orphan's tree.
const pkg = names => new RegExp(`(?:[\\\\/]node_modules[\\\\/]|[\\\\/]install[\\\\/]cache[\\\\/])(?:${names})(?:@[^\\\\/\\s]*)?[\\\\/]`, 'i')
const PYTHON = /^(?:python[\d.]*|pythonw|py|pytest|py\.test)$/i
const BROWSER = /^(?:chrome|chromium(?:-browser)?|chrome-headless-shell|headless_shell|msedge|firefox|playwright|minibrowser|google chrome.*|microsoft edge.*)$/i
// Headless, or driven over a pipe by Playwright or Puppeteer (their own temp profiles too).
const AUTOMATION = /\s-?-headless\b|--remote-debugging-pipe|-juggler-pipe|--inspector-pipe|playwright_\w*profile|puppeteer_dev_\w*profile/i

const RULES = [
  { rule: 'test-runner', what: 'Vitest and its worker pool (tinypool)', cmd: pkg('vitest|tinypool'),
    reason: 'One worker per CPU core by default, each holding hundreds of MB; they never exit without their runner.' },
  { rule: 'test-runner', what: 'Jest and jest-worker children', cmd: pkg('jest|jest-cli|jest-worker|@jest[\\\\/]core'),
    reason: 'Same worker-per-core pool; a stuck worker keeps its memory forever.' },
  { rule: 'test-runner', what: 'Mocha, including `--parallel` workers', cmd: pkg('mocha'),
    reason: 'A watch or hung run never exits.' },
  { rule: 'test-runner', what: 'AVA and its workers', cmd: pkg('ava'),
    reason: 'One worker process per test file.' },
  { rule: 'test-runner', what: '`node --test`, `bun test`, `deno test`',
    test: (p, name) => (/^node$/i.test(name) && /\s--test(?:[\s=-]|$)/.test(p.cmd)) || (/^(?:bun|deno)$/i.test(name) && /\stest(?:\s|$)/.test(p.cmd)),
    reason: 'The built-in runners start a child per test file.' },
  { rule: 'test-runner', what: 'Playwright Test runner and workers', cmd: pkg('@playwright[\\\\/]test|playwright|playwright-core'),
    reason: 'Each worker drives its own browser.' },
  { rule: 'test-runner', what: 'pytest', name: PYTHON, cmd: /(?:^|[\s\\/"'])(?:py\.test|pytest)(?:\.exe)?(?=["'\s]|$)|\s-m\s+pytest\b/i,
    reason: 'A hung test keeps the interpreter and its fixtures alive.' },
  { rule: 'test-runner', what: 'pytest-xdist workers (execnet)', name: PYTHON, cmd: /exec\(eval\(sys\.stdin\.readline\(\)\)\)/,
    reason: 'Workers outlive a killed controller; hundreds were reported left behind (anthropics/claude-code#25180).' },
  { rule: 'test-runner', what: '`cargo test` and `cargo nextest`', name: /^cargo$/i, cmd: /\s(?:test|nextest)(?:\s|$)/,
    reason: 'Compiles and runs test binaries, several GB while linking.' },
  { rule: 'test-runner', what: 'Rust test binaries (`target/*/deps/<name>-<hash>`)', cmd: /[\\/]target[\\/](?:[^\\/\s"]+[\\/]){1,2}deps[\\/][\w-]+-[0-9a-f]{16}(?:\.exe)?(?=["\s]|$)/i,
    reason: 'A hung test binary never exits on its own.' },
  { rule: 'test-runner', what: '`go test` and its test binaries (`*.test`)', test: (p, name) => (/^go$/i.test(name) && /\stest(?:\s|$)/.test(p.cmd)) || /\.test$/i.test(name),
    reason: 'Same: a hung test binary never exits on its own.' },
  { rule: 'test-runner', what: '`dotnet test` and testhost', name: /^(?:dotnet|testhost(?:\.x86)?)$/i, cmd: /\stest(?:\s|$)|testhost/i,
    reason: 'The test host stays up while a test hangs.' },
  { rule: 'watcher', what: '`tsc --watch`', cmd: /(?:[\\/]typescript[\\/]bin[\\/]tsc|\btsc(?:\.cmd|\.js)?)["']?\s(?:.*\s)?(?:-w|--watch)(?:\s|$)/i,
    reason: 'Watchers never exit.' },
  { rule: 'watcher', what: 'Vite, webpack, esbuild, Rollup or Parcel with `--watch`', cmd: /\b(?:vite|webpack(?:-cli)?|esbuild|rollup|parcel)\b(?:.*\s)?(?:--watch|-w)(?:[\s=]|$)/i,
    reason: 'Watchers never exit.' },
  { rule: 'watcher', what: 'nodemon, `node --watch`, `tsx watch`, ts-node-dev, chokidar',
    test: (p, name) => /[\\/](?:nodemon|ts-node-dev|chokidar-cli)[\\/]|\bnodemon(?:\.cmd)?\b|\btsx\b\S*\s+watch\b/i.test(p.cmd) || (/^node$/i.test(name) && /\s--watch(?:[\s=-]|$)/.test(p.cmd)),
    reason: 'Watchers never exit, and restart their child on every file change.' },
  { rule: 'builder', what: '`next build`', cmd: /\bnext["']?\s+build\b/i,
    reason: 'Several GB for minutes; a second build in the same tree fails while it runs.' },
  { rule: 'builder', what: 'Turborepo task runs (`turbo run`, `turbo build`, ...)', cmd: /\bturbo(?:\.exe|\.cmd)?["']?\s+(?!daemon\b)\w/i,
    reason: 'Runs many package builds at once.' },
  { rule: 'builder', what: '`vite build`, webpack, Rollup and `tsc` one-shot builds', cmd: /[\\/]vite[\\/]bin[\\/]vite\.js["']?\s+build\b|[\\/]node_modules[\\/](?:webpack|webpack-cli|rollup)[\\/]bin[\\/]|[\\/]typescript[\\/]bin[\\/]tsc\b/i,
    reason: 'Holds its memory until it finishes, while nobody reads the result.' },
  { rule: 'headless-browser', what: 'Headless or automation browsers (Chrome, Chromium, Edge, Firefox, WebKit) started with `--headless`, a debugging pipe, or a Playwright or Puppeteer profile', name: BROWSER, cmd: AUTOMATION, root: true,
    reason: 'Each instance holds hundreds of MB; Playwright and Puppeteer leave them behind when the runner is killed.' },
  { rule: 'dev-server', what: 'Anything listening on a TCP port', listening: true,
    reason: 'Holds the port the next session in that project will want, and its memory.' },
]

// Never stopped, nor anything they started, even under an orphaned shell: programs meant to
// outlive the session, and daemons that other sessions share.
const KEEP = [
  { what: 'Claude Code itself', test: p => isClaude(p), reason: 'A session started from a tool shell is a live session of its own.' },
  { what: 'orphan-reaper itself', cmd: /orphan-reaper\.js/, reason: 'The reaper and its waiters.' },
  { what: 'Editors and IDEs (VS Code, Cursor, Windsurf, Zed, Sublime Text, JetBrains IDEs, Android Studio, Visual Studio, Vim, Emacs)',
    name: /^(?:code|code - insiders|code-insiders|codium|vscodium|cursor|windsurf|zed|subl|sublime_text|atom|idea\d*|pycharm\w*|webstorm\w*|goland\w*|rider\w*|clion\w*|phpstorm\w*|rubymine\w*|datagrip\w*|rustrover\w*|fleet|studio\d*|devenv|notepad\+\+|vim|nvim|gvim|nvim-qt|neovide|emacs|emacsclient|nano|xcode)$/i,
    reason: '`code .` from a tool shell opens your editor; it is yours, not the session\'s.' },
  { what: 'Terminals and multiplexers (Windows Terminal, iTerm2, GNOME Terminal, kitty, WezTerm, tmux, screen, ...)',
    name: /^(?:windowsterminal|wt|openconsole|mintty|conemu\w*|alacritty|kitty|wezterm(?:-gui|-mux-server)?|gnome-terminal(?:-server|\.real)?|konsole|xterm|urxvt|terminator|tilix|iterm2|terminal|ghostty|hyper|tabby|warp|tmux|tmux: server|screen|zellij|explorer)$/i,
    reason: 'A terminal opened from a tool shell is yours, and so is everything you run in it.' },
  { what: 'macOS app bundles that are not automation browsers', test: p => /\.app[\\/]Contents[\\/]MacOS[\\/]/.test(p.cmd) && !AUTOMATION.test(p.cmd),
    reason: 'GUI apps opened with `open` are yours.' },
  { what: 'Shared build daemons (Gradle, Kotlin, MSBuild node reuse, VBCSCompiler, Bazel, Buck2, sccache, Turborepo and Nx daemons)',
    test: (p, name) => /^(?:vbcscompiler|bazel|buck2d|sccache)$/i.test(name) ||
      /org\.gradle\.launcher\.daemon|GradleDaemon|KotlinCompileDaemon|org\.jetbrains\.kotlin\.daemon|[\\/]nx[\\/]src[\\/]daemon[\\/]|\bturbo(?:\.exe)?["']?\s+daemon\b|MSBuild\.(?:dll|exe)["']?\s.*\/nodemode/i.test(p.cmd),
    reason: 'Builds in every session connect to the same daemon; stopping it breaks theirs.' },
  { what: 'Shared machine services (adb, the Android emulator, Docker, Ollama, watchman, ssh-agent, gpg-agent)',
    name: /^(?:adb|emulator|emulator64-\w+|qemu-system-[\w-]+|dockerd|docker|containerd|com\.docker\.[\w.-]+|ollama|watchman|ssh-agent|gpg-agent)$/i,
    reason: 'One instance serves every session on the machine.' },
]

const SHELL = /^(?:bash|sh|dash|zsh|fish|ksh|cmd|powershell|pwsh|wsl|env|nohup|sudo|timeout|time|nice|setsid)$/i
const CLAUDE_SHELL = /shell-snapshots[\\/]snapshot-|CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT/
const SNAPSHOT_NAME = /snapshot-\w+-(\d{13})-\w+\.\w+/
const POWERSHELL_MIN_AGE_MS = 6 * 3600 * 1000
// Claude Code writes the shell snapshot a little after the session starts, at its first Bash call.
const SNAPSHOT_AFTER_START_MS = 5000
const WAIT_LIMIT_MS = 3 * 60 * 1000
const POLL_MS = 1000

const baseName = name => String(name || '').replace(/\.exe$/i, '')

// Generous on purpose: anything that might be Claude ends a parent chain as a live session. The
// native installer runs versions/<x.y.z> through a `claude` link, so the name alone can differ.
function isClaude(p) {
  if (/^claude(?:\.exe)?$/i.test(p.name)) return true
  if (/^["']?(?:\S*[\\/])?claude(?:\.exe)?["']?(?:\s|$)|[\\/]claude[\\/]versions[\\/]/i.test(p.cmd)) return true
  return /^(?:node|bun)(?:\.exe)?$/i.test(p.name) && /claude-code|@anthropic-ai[\\/]claude/i.test(p.cmd)
}

function matchesSpec(spec, p, name) {
  if (spec.test && !spec.test(p, name)) return false
  if (spec.name && spec.cmd) return spec.name.test(name) && spec.cmd.test(p.cmd)
  if (spec.name) return spec.name.test(name)
  if (spec.cmd) return spec.cmd.test(p.cmd)
  return Boolean(spec.test)
}

function keeper(keepNames = []) {
  const extra = new Set(keepNames.map(n => baseName(n).toLowerCase()))
  const cache = new Map()
  return p => {
    if (!cache.has(p.pid)) {
      const name = baseName(p.name)
      cache.set(p.pid, extra.has(name.toLowerCase()) || KEEP.some(k => matchesSpec(k, p, name)))
    }
    return cache.get(p.pid)
  }
}

// The first rule a process matches, or null.
function ruleFor(p, { listening = new Set(), extraNames = [] } = {}) {
  const name = baseName(p.name)
  if (SHELL.test(name)) return null
  for (const r of RULES) {
    if (r.listening) {
      if (listening.has(p.pid)) return r
      continue
    }
    // a browser's renderers and GPU helpers carry --type=; its root process is enough
    if (r.root && /--type=/.test(p.cmd)) continue
    if (matchesSpec(r, p, name)) return r
  }
  const lower = name.toLowerCase()
  if (extraNames.some(n => baseName(n).toLowerCase() === lower)) {
    return { rule: 'extra-name', what: 'Program names in `orphanReaper.extraNames`', reason: 'You listed them.' }
  }
  return null
}

// Where the snapshot file named in a shell's command line lives, or null when that cannot be told
// for certain. MSYS paths such as /c/Users/... are mapped to C:/Users/... on Windows.
function snapshotPath(cmd, platform = process.platform) {
  const m = /(["'])([^"']*?shell-snapshots[\\/]snapshot-\w+-\d{13}-\w+\.\w+)\1/.exec(cmd) || /()(\S*shell-snapshots[\\/]snapshot-\w+-\d{13}-\w+\.\w+)/.exec(cmd)
  if (!m) return null
  let p = m[2]
  if (platform === 'win32') {
    p = p.replace(/^\/(?:cygdrive\/)?([a-z])\//i, (_, d) => `${d.toUpperCase()}:/`)
    return /^[a-z]:[\\/]/i.test(p) ? p : null
  }
  return p.startsWith('/') ? p : null
}

// true when the file is there or we cannot tell; false only when its folder exists without it.
function snapshotExists(file) {
  if (!file) return true
  try {
    if (!fs.statSync(path.dirname(file)).isDirectory()) return true
  } catch {
    return true
  }
  return fs.existsSync(file)
}

// Linux and macOS: Claude Code exports CLAUDE_PID to tool shells and children inherit it.
// A reused PID shows up as an owner younger than the process, or one that is not Claude.
function ownerByEnv(p, ctx) {
  const owner = ctx.byPid.get(p.claudePid)
  if (owner && owner.start <= p.start && isClaude(owner)) return null
  const s = ctx.session
  if (s && (p.claudePid !== s.pid || p.start < s.since)) return null
  let top = p
  for (let i = 0; i < 30; i++) {
    if (ctx.isKept(top)) return null
    const par = ctx.byPid.get(top.ppid)
    if (!par || par.pid <= 1 || par.claudePid !== p.claudePid || par.start > top.start) break
    top = par
  }
  return {
    top,
    owner: p.claudePid,
    why: owner ? `Claude PID ${p.claudePid} now belongs to a newer process (${owner.name})` : `its Claude session (PID ${p.claudePid}) has exited`,
  }
}

// Walks ParentProcessId up from p. Windows does not reparent, so a dead session leaves a dangling
// parent above its tool shell; on Linux and macOS the chain ends at init or launchd. A child is
// never older than its parent, so an older "parent" means its PID was reused.
function walkChain(p, byPid, isKept = () => false) {
  let cur = p
  let shellTop = null
  let snapshot = null
  let kept = false
  for (let i = 0; i < 30; i++) {
    if (isKept(cur)) kept = true
    if (CLAUDE_SHELL.test(cur.cmd)) {
      shellTop = cur
      const m = SNAPSHOT_NAME.exec(cur.cmd)
      if (m && !snapshot) snapshot = { ms: Number(m[1]), name: m[0], cmd: cur.cmd }
    }
    const par = byPid.get(cur.ppid)
    if (!par || par.pid <= 1 || par.start > cur.start) return { broken: true, top: shellTop, snapshot, kept, owner: cur.ppid, dangling: cur }
    if (isClaude(par)) return { broken: false, claude: par.pid, snapshot }
    cur = par
  }
  return { broken: false, snapshot }
}

// Snapshot timestamps used by tool shells whose chain still reaches a live Claude process.
function liveSnapshots(procs, byPid) {
  const out = new Set()
  for (const p of procs) {
    if (!CLAUDE_SHELL.test(p.cmd) || !SNAPSHOT_NAME.test(p.cmd)) continue
    const c = walkChain(p, byPid)
    if (!c.broken && c.claude && c.snapshot) out.add(c.snapshot.ms)
  }
  return out
}

// Windows, and Linux or macOS when the environment is unreadable: the chain has to pass through a
// Claude Bash or PowerShell tool shell and then end at a parent that no longer exists. A live
// session whose shell backgrounded a job with `&` leaves the same dangling parent, so more proof
// is needed before anything is stopped.
function ownerByChain(p, ctx) {
  const chain = walkChain(p, ctx.byPid, ctx.isKept)
  if (!chain.broken || !chain.top || chain.kept) return null
  const s = ctx.session
  const top = chain.top
  // After SessionEnd: a shell whose missing parent is exactly the Claude process we watched exit,
  // and that started during its lifetime, is that session's.
  if (s && chain.owner === s.pid && chain.dangling.start >= s.since && chain.dangling.start <= s.endedAt) {
    return { top, owner: s.pid, why: `its Claude session (PID ${s.pid}) has just exited` }
  }
  const snap = chain.snapshot
  if (!snap) {
    // PowerShell tool shells carry no snapshot name to tie them to a session
    if (s || ctx.now - p.start < POWERSHELL_MIN_AGE_MS) return null
    return { top, owner: chain.owner, why: `its PowerShell tool shell lost its Claude parent ${Math.floor((ctx.now - p.start) / 3600e3)} h ago` }
  }
  if (s && (snap.ms < s.since - SNAPSHOT_AFTER_START_MS || snap.ms > s.endedAt)) return null
  if (ctx.live.has(snap.ms)) return null
  // Claude Code removes its snapshot file when the session exits cleanly.
  if (!ctx.snapshotExists(snapshotPath(snap.cmd, ctx.platform))) {
    return { top, owner: s ? s.pid : chain.owner, why: `its session has exited and removed ${snap.name}` }
  }
  // The file is still there after a crash, or the session is alive. The snapshot is written at a
  // session's first Bash call, which can be long after it started, so any Claude process started
  // before the snapshot may own it.
  if (ctx.liveClaudeStarts.some(t => t <= snap.ms + SNAPSHOT_AFTER_START_MS)) return null
  return { top, owner: s ? s.pid : chain.owner, why: `no running Claude session is older than ${snap.name}` }
}

// [{ pid, top, name, cmd, owner, rule, what, why }]: one entry per tree to stop. `session` limits
// the result to one session that has just exited: { pid, since, endedAt }.
function findOrphans({ procs, listening = new Set() }, now = Date.now(), opts = {}) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const ctx = {
    byPid,
    now,
    session: opts.session || null,
    platform: opts.platform || process.platform,
    isKept: keeper(opts.keepNames),
    snapshotExists: opts.snapshotExists || snapshotExists,
    liveClaudeStarts: procs.filter(isClaude).map(p => p.start),
    live: liveSnapshots(procs, byPid),
  }
  const self = opts.self === undefined ? process.pid : opts.self
  const found = []
  const seen = new Set()
  for (const p of procs) {
    if (p.pid === self) continue
    const r = ruleFor(p, { listening, extraNames: opts.extraNames })
    if (!r || ctx.isKept(p)) continue
    const own = p.claudePid ? ownerByEnv(p, ctx) : ownerByChain(p, ctx)
    if (!own || seen.has(own.top.pid)) continue
    seen.add(own.top.pid)
    found.push({ pid: p.pid, top: own.top.pid, name: p.name, cmd: p.cmd, owner: own.owner, rule: r.rule, what: r.what, why: own.why })
  }
  return found
}

// The tree under rootPid, parents first, without any subtree rooted at a kept process. A child
// must not be older than its parent, which skips processes whose parent PID was reused.
function descendants(rootPid, procs, isKept = () => false) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const kids = new Map()
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, [])
    kids.get(p.ppid).push(p)
  }
  const root = byPid.get(rootPid)
  if (!root) return [rootPid]
  if (isKept(root)) return []
  const out = [root]
  const seen = new Set([rootPid])
  for (let i = 0; i < out.length; i++) {
    for (const c of kids.get(out[i].pid) || []) {
      if (seen.has(c.pid) || c.start < out[i].start || isKept(c)) continue
      seen.add(c.pid)
      out.push(c)
    }
  }
  return out.map(p => p.pid)
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// Stops exactly these PIDs. No taskkill /T: it follows parent PIDs without checking start times,
// so it can reach an unrelated process whose parent PID was reused.
function killPids(pids, platform = process.platform) {
  if (!pids.length) return
  if (platform === 'win32') {
    for (let i = 0; i < pids.length; i += 32) {
      const args = ['/F']
      for (const pid of pids.slice(i, i + 32)) args.push('/PID', String(pid))
      try { execFileSync('taskkill', args, { stdio: 'ignore', windowsHide: true, timeout: 30000 }) } catch {}
    }
    return
  }
  const order = [...pids].reverse()
  for (const pid of order) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  for (let waited = 0; waited < 3000 && order.some(alive); waited += 100) sleep(100)
  for (const pid of order) {
    if (alive(pid)) try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

// Stops every orphan's tree and returns { orphan, pids } for each. On Windows a second look stops
// children that a dying process started after the first snapshot; elsewhere they are reparented
// and the next pass finds them through CLAUDE_PID.
function reapAll(orphans, procs, { platform = process.platform, keepNames = [], reread = null } = {}) {
  const isKept = keeper(keepNames)
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const done = []
  const killed = new Map()
  for (const o of orphans) {
    const pids = [...new Set([...descendants(o.top, procs, isKept), o.pid])].filter(pid => !killed.has(pid))
    killPids(pids, platform)
    for (const pid of pids) killed.set(pid, byPid.get(pid))
    done.push({ orphan: o, pids })
  }
  if (platform === 'win32' && killed.size && reread) {
    let later = null
    try { later = reread() } catch {}
    if (later) {
      const now = new Map(later.procs.map(p => [p.pid, p]))
      const late = later.procs.filter(p => {
        const parent = killed.get(p.ppid)
        return parent && !now.has(p.ppid) && p.start >= parent.start && !killed.has(p.pid)
      })
      const pids = [...new Set(late.flatMap(p => descendants(p.pid, later.procs, isKept)))]
      killPids(pids, platform)
    }
  }
  return done
}

// The exited session's project, from the session file Claude Code may have left behind.
function projectOf(ownerPid, files) {
  const f = ownerPid && files.get(ownerPid)
  return (f && f.cwd) || null
}

function settings() {
  return {
    extraNames: setting('orphanReaper.extraNames', []),
    keepNames: setting('orphanReaper.keepNames', []),
  }
}

function snapshotNow(platform) {
  return readProcesses(platform, { withEnv: true })
}

// One pass: find, stop, record. Returns the list of { orphan, pids } (planned only, for a dry run).
function run({ platform = process.platform, dryRun = false, session = null, trigger = 'startup', sessionId = null, project = null, snap = null } = {}) {
  const opts = settings()
  const snapshot = snap || snapshotNow(platform)
  const orphans = findOrphans(snapshot, Date.now(), { ...opts, session, platform })
  if (dryRun) {
    const isKept = keeper(opts.keepNames)
    return orphans.map(o => ({ orphan: o, pids: [...new Set([...descendants(o.top, snapshot.procs, isKept), o.pid])] }))
  }
  const done = reapAll(orphans, snapshot.procs, { platform, keepNames: opts.keepNames, reread: () => snapshotNow(platform) })
  const files = done.length && !project ? readSessionFiles() : new Map()
  for (const { orphan: o, pids } of done) {
    log('orphan-reaper', `stopped ${o.rule} pid ${o.pid} (tree ${o.top}, ${pids.length} processes; ${o.why}) ${oneLine(o.cmd || o.name, 160)}`)
    recordEvent('orphan-reaper', o.rule, { session_id: sessionId }, o.cmd || o.name, {
      project: project || projectOf(o.owner, files),
      pid: o.pid,
      trigger,
    })
  }
  return done
}

// The Claude process a SessionEnd hook belongs to and when it started, from its session file
// (Windows writes the exact creation time as procStart), else CLAUDE_PID, else our parent.
function sessionOf(input, { env = process.env, dir = path.join(claudeDir(), 'sessions'), ppid = process.ppid } = {}) {
  let names = []
  try { names = fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n)) } catch {}
  const byEnv = Number(env.CLAUDE_PID) || null
  let file = null
  for (const n of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))
      if (s && s.pid && ((input.session_id && s.sessionId === input.session_id) || (!file && s.pid === byEnv))) file = s
    } catch {}
  }
  const pid = (file && Number(file.pid)) || byEnv || ppid
  let since = 0
  if (file) {
    const started = Number(file.startedAt) || 0
    // Windows FILETIME: 100 ns ticks since 1601
    const exact = /^\d{17,19}$/.test(String(file.procStart || '')) ? Number(BigInt(file.procStart) / 10000n) - 11644473600000 : 0
    since = exact && started && Math.abs(exact - started) < 600e3 ? exact : Math.max(0, started - 120e3)
  }
  return { pid, since }
}

// clear and resume keep the same Claude process running.
const KEEPS_RUNNING = new Set(['clear', 'resume'])

// SessionEnd: Claude Code waits at most 1.5 s for this hook and exits right after, so the hook only
// starts a hidden, detached waiter and returns.
function onSessionEnd(input, { env = process.env, start = startWaiter } = {}) {
  if (KEEPS_RUNNING.has(input.reason)) return null
  if (setting('orphanReaper.onSessionEnd', true) === false) return null
  const { pid, since } = sessionOf(input, { env })
  if (!pid || pid <= 1) return null
  const args = ['--after-exit', String(pid), '--since', String(since)]
  if (input.session_id) args.push('--session', String(input.session_id))
  const project = env.CLAUDE_PROJECT_DIR || input.cwd
  if (project) args.push('--project', String(project))
  start(args)
  return args
}

function startWaiter(args) {
  const child = spawn(process.execPath, [__filename, ...args], { detached: true, windowsHide: true, stdio: 'ignore', cwd: os.homedir() })
  child.unref()
}

function argValue(argv, name) {
  const i = argv.indexOf(name)
  if (i >= 0) return argv[i + 1]
  const eq = argv.find(a => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : undefined
}

// The waiter: polls until the session's Claude process exits, then stops that session's orphans.
function afterExit(argv, platform = process.platform) {
  const pid = Number(argValue(argv, '--after-exit'))
  const since = Number(argValue(argv, '--since')) || 0
  const limit = Number(argValue(argv, '--max-wait')) * 1000 || WAIT_LIMIT_MS
  if (!pid) return
  const t0 = Date.now()
  while (alive(pid) && Date.now() - t0 < limit) sleep(POLL_MS)
  const snap = snapshotNow(platform)
  const still = snap.procs.find(p => p.pid === pid)
  // still our Claude: started before we did. A newer process means the PID was reused.
  if (still && isClaude(still) && still.start <= t0) {
    log('orphan-reaper', `gave up waiting for Claude PID ${pid} after ${Math.round(limit / 1000)} s`)
    return
  }
  const done = run({
    platform, snap, trigger: 'session-end',
    session: { pid, since, endedAt: Date.now() },
    sessionId: argValue(argv, '--session') || null,
    project: argValue(argv, '--project') || null,
  })
  log('orphan-reaper', `session ${pid} exited; stopped ${done.length} orphan tree${done.length === 1 ? '' : 's'}`)
}

const SUPPORTED = ['win32', 'linux', 'darwin']

function readStdin() {
  return new Promise(resolve => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', d => (raw += d))
    process.stdin.on('end', () => resolve(raw))
    process.stdin.on('error', () => resolve(raw))
  })
}

async function main(argv) {
  if (argv.includes('--dry-run')) return require('./reap-cli').main(['--dry-run'])
  if (!enabled('orphan-reaper') || !SUPPORTED.includes(process.platform)) return
  if (argv.includes('--session-end')) {
    let input = {}
    try { input = JSON.parse((await readStdin()) || '{}') } catch {}
    onSessionEnd(input)
    return
  }
  try {
    if (argv.includes('--after-exit') || argv.some(a => a.startsWith('--after-exit='))) afterExit(argv)
    else run()
  } catch (e) {
    log('orphan-reaper', `failed: ${oneLine(e.message, 200)}`)
  }
}

if (require.main === module) {
  Promise.resolve().then(() => main(process.argv.slice(2))).catch(() => {}).then(() => process.exit(0))
}

module.exports = {
  findOrphans, descendants, ruleFor, keeper, run, reapAll, snapshotPath, snapshotExists, sessionOf, onSessionEnd, afterExit, isClaude,
  RULES, KEEP, SUPPORTED, WAIT_LIMIT_MS,
}
