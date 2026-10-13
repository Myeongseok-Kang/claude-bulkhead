'use strict'
// Shared by test/corpus.test.js and test/fuzz.test.js: temporary repositories, machine-state
// fixtures, and a pool that runs hook scripts the way Claude Code does (JSON on stdin,
// verdict in the exit code). Loading this file has no side effects.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')
const MOCK = path.join(__dirname, 'mock.js')

// The PreToolUse guards, in the order hooks/hooks.json runs them.
const GUARDS = ['kill-guard', 'wait-guard', 'memory-guard', 'port-guard', 'checkout-guard', 'basics']

const PLENTY = { freeGb: 24, totalGb: 32, commitPct: 20 }
const LOW = { freeGb: 0.8, totalGb: 32, commitPct: 20 }

// Ports a dev server picks by default; in the "busy" fixture another session holds all of them.
const BUSY_PORTS = [1313, 3000, 3001, 4000, 4173, 4200, 4321, 5000, 5173, 6006, 8000, 8080, 8081, 8787]

function realTemp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=corpus', '-c', 'user.email=corpus@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
}

const PACKAGE_JSON = {
  name: 'shop',
  private: true,
  scripts: {
    dev: 'next dev',
    start: 'next start',
    build: 'next build',
    test: 'vitest run',
    'dev:vite': 'vite',
    preview: 'vite preview',
    storybook: 'storybook dev -p 6006',
    lint: 'eslint .',
  },
}

// A small project on branch main with one commit. `dirty` adds a modified tracked file
// and an untracked one, which is what basics and checkout-guard look for.
function makeRepo({ dirty = false } = {}) {
  const dir = realTemp('bulkhead-corpus-')
  git(dir, 'init', '-q')
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(PACKAGE_JSON, null, 2) + '\n')
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'module.exports = 1\n')
  fs.writeFileSync(path.join(dir, 'README.md'), '# shop\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  if (dirty) {
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'module.exports = 2\n')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'scratch\n')
  }
  return dir
}

const t0 = Date.UTC(2026, 0, 5, 8)
const proc = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd, start, rss: 0, claudePid: null })

// Session 900100 holds every default dev port; the hook runs as session 900200.
function busySnapshot() {
  const procs = [
    proc(900100, 1, 'claude', 'claude', t0),
    proc(900110, 900100, 'bash', 'bash -c "npm run dev"', t0 + 10e3),
    proc(900111, 900110, 'node', 'node server', t0 + 11e3),
    proc(900200, 1, 'claude', 'claude', t0 + 60e3),
  ]
  return { procs, ports: BUSY_PORTS.map(port => ({ port, pid: 900111 })) }
}

// State names used by the corpus: what the machine looks like while the hooks run.
//   quiet: plenty of RAM, no other Claude session anywhere, nothing listening.
//   low-ram: as quiet, but RAM is nearly gone.
//   busy-ports: another session holds every default dev port.
//   shared-tree: another live session works in the same (dirty) repository.
function stateFor(name, { cleanRepo, dirtyRepo }) {
  const base = { memory: PLENTY, cwd: cleanRepo, mock: { listening: false, self: null, sessionFiles: [] } }
  switch (name) {
    case 'quiet':
      // Something answers on every port, but it belongs to no session: port-guard reads the
      // (empty) process table and must still allow.
      return { ...base, mock: { listening: true, self: 900200, sessionFiles: [], snapshot: { procs: [], ports: [] } } }
    case 'low-ram':
      return { ...base, memory: LOW }
    case 'busy-ports':
      return { ...base, mock: { listening: true, self: 900200, sessionFiles: [[900100, { cwd: '/srv/other-project', startedAt: 0, sessionId: 'other' }]], snapshot: busySnapshot() } }
    case 'shared-tree':
      return { ...base, cwd: dirtyRepo, mock: { listening: false, self: null, sessionFiles: [[process.pid, { cwd: dirtyRepo, startedAt: t0, sessionId: 'other-session' }]] } }
    case 'dirty':
      return { ...base, cwd: dirtyRepo }
    default:
      throw new Error('unknown state ' + name)
  }
}

function cleanEnv(extra) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(?:BULKHEAD_|CLAUDE_)/.test(k) || k === 'NODE_OPTIONS') continue
    env[k] = v
  }
  return { ...env, ...extra }
}

// The PreToolUse payload Claude Code sends.
function payload(command, { cwd, tool = 'Bash', timeout = 120000, sessionId = 'corpus-session' } = {}) {
  const tool_input = { command, timeout, description: 'corpus' }
  return {
    session_id: sessionId,
    transcript_path: path.join(os.tmpdir(), 'bulkhead-corpus-transcript.jsonl'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input,
    tool_use_id: 'toolu_corpus',
  }
}

// Runs one hook script. Resolves { status, stdout, stderr, ms }.
// The hook never sees the real home: the state directory (event log, config.json) and the Claude
// config directory are temporary. Directories this function creates are removed afterwards.
function runHook(guard, input, { cwd, memory = PLENTY, mock = {}, env = {}, stateDir, configDir, timeoutMs = 30000 } = {}) {
  const stdin = typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify(input)
  const own = []
  if (!stateDir) own.push((stateDir = realTemp('bulkhead-state-')))
  if (!configDir) own.push((configDir = realTemp('bulkhead-config-')))
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(process.execPath, ['--require', MOCK, path.join(ROOT, 'src', `${guard}.js`)], {
      cwd: cwd || os.tmpdir(),
      windowsHide: true,
      env: cleanEnv({
        BULKHEAD_STATE_DIR: stateDir,
        CLAUDE_CONFIG_DIR: configDir,
        BULKHEAD_TEST_MEMORY: JSON.stringify(memory),
        BULKHEAD_CORPUS_MOCK: JSON.stringify(mock),
        ...env,
      }),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', status => {
      clearTimeout(timer)
      for (const dir of own) fs.rmSync(dir, { recursive: true, force: true })
      resolve({ status, stdout, stderr, ms: Date.now() - started })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
}

// Runs jobs (functions returning promises) with a fixed number in flight.
async function pool(jobs, size = Math.max(2, Math.min(8, os.cpus().length))) {
  const out = new Array(jobs.length)
  let next = 0
  async function worker() {
    while (next < jobs.length) {
      const i = next++
      out[i] = await jobs[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker))
  return out
}

// Corpus files: one command per line, `#` comments, `<NL>` for a newline inside a command.
// Directives apply to the lines that follow them:
//   #@ tool PowerShell        the tool name in the payload (Bash by default)
//   #@ state low-ram          the machine state the lines run in (allow.txt; quiet by default)
//   #@ timeout 600000         the tool timeout in the payload (allow.txt; 120000 by default)
//   #@ config {json}          a global config.json the hooks read; `#@ config none` ends it
// A trailing `\t# todo: reason` marks a known bug in src/: the line is reported as a todo test.
function readCorpus(file) {
  const entries = []
  let tool = 'Bash'
  let section = ''
  let state = null
  let config = null
  let timeout = null
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const directive = /^#@\s*(tool|state|config|timeout)\s+(.+?)\s*$/.exec(line)
    if (directive) {
      const [, key, value] = directive
      if (key === 'tool') tool = value
      else if (key === 'timeout') timeout = value === 'default' ? null : Number(value)
      else if (key === 'state') state = value === 'default' ? null : value
      else config = value === 'none' ? null : JSON.stringify(JSON.parse(value))
      return
    }
    if (/^#\s*==/.test(line)) { section = line.replace(/^#\s*=+\s*|\s*=*\s*$/g, ''); return }
    if (!line.trim() || /^\s*#/.test(line)) return
    let todo = null
    const t = /\t#\s*todo:\s*(.*)$/.exec(line)
    if (t) { todo = t[1].trim(); line = line.slice(0, t.index) }
    entries.push({ line: i + 1, raw: line, tool, section, todo, state, config, timeout })
  })
  return entries
}

const decode = s => s.replace(/<NL>/g, '\n').replace(/<TAB>/g, '\t')

// A stack trace or an uncaught error printed by node.
const CRASH = /\n\s+at .+[:(]\d+:\d+|^(?:\w*Error|TypeError|RangeError|SyntaxError)\b|Uncaught|node:internal/m

module.exports = { GUARDS, PLENTY, LOW, BUSY_PORTS, makeRepo, realTemp, stateFor, payload, runHook, pool, readCorpus, decode, CRASH, busySnapshot }
