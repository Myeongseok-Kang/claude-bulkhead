'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const config = require('./config')
const { stateDir } = require('./hook')
const { pathKey } = require('./paths')
const sh = require('./remote-sh')
const remotes = require('./remotes')
const { useColor, paint, table, bytes, shortPath } = require('./cli-util')

const USAGE = `usage:
  bulkhead remote run [--remote=NAME] [--gb=N] [--wait=MINUTES] [--files=a,b] [--tail=N]
                      [--fetch=PATH,...] [--label=TEXT] [--project=NAME] -- <command...>
  bulkhead remote fetch <path> [<local dir>] [--copy=LETTER] [--remote=NAME] [--project=NAME]
  bulkhead remote status [--remote=NAME] [--json]
  bulkhead remote list [--json]
  bulkhead remote add <name> <user@host> [--shell=CMD] [--dir=PATH] [--copies=N] [--max-jobs=N]
                      [--min-free-gb=N] [--ssh-option=KEY=VALUE]... [--default] [--no-check]
  bulkhead remote remove <name>

run sends this repository's HEAD commit and uncommitted changes to the remote, runs the
command in a copy of its own with BULKHEAD_PORT set, and passes its exit code back.
Exit codes: the command's own; 3 no free copy or room within --wait; 4 transfer or setup
failed; 5 the remote cannot be reached. See docs/remote.md.`

const EXIT = { USAGE: 2, NO_ROOM: 3, TRANSFER: 4, UNREACHABLE: 5 }
// Fail fast instead of prompting, and notice a dead connection within about three minutes.
const SSH_BASE = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', '-o', 'LogLevel=ERROR']
const LOG_KEEP = 50

class Failure extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

const say = (stream, line) => stream.write(`[bulkhead remote] ${line}\n`)
const token = () => crypto.randomBytes(8).toString('hex')
const posixQuote = a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

function duration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function age(seconds) {
  const s = Number(seconds) || 0
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(1)} h`
}

// ---- local tools ----

function envGet(env, name) {
  const k = Object.keys(env).find(x => x.toUpperCase() === name)
  return k ? env[k] : undefined
}

function which(name, env = process.env, platform = process.platform) {
  const dirs = String(envGet(env, 'PATH') || '').split(path.delimiter).filter(Boolean)
  const exts = platform === 'win32' ? String(envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const d of dirs) {
    for (const e of platform === 'win32' && path.extname(name) ? [''] : exts) {
      const f = path.join(d, name + e.toLowerCase())
      try {
        if (fs.statSync(f).isFile()) return f
      } catch {}
    }
  }
  return null
}

// BULKHEAD_SSH replaces the ssh program with an argv prefix, as JSON: ["ssh"] or
// ["node", "test/fake-ssh.js"]. Tests use it to run the remote side on this machine; it also
// works for wrappers such as a VPN or a jump tool.
function sshCommand(env = process.env) {
  const raw = env.BULKHEAD_SSH
  if (raw) {
    let a
    try { a = JSON.parse(raw) } catch {}
    if (Array.isArray(a) && a.length && a.every(x => typeof x === 'string' && x)) return a
    throw new Failure('BULKHEAD_SSH should be a JSON array of strings, such as ["ssh"]', EXIT.USAGE)
  }
  const found = which('ssh', env)
  return found ? [found] : null
}

// On Windows, Git's GNU tar reads UTF-8 file lists; the bsdtar in System32 reads them in the
// ANSI code page. Use Git's when it is installed.
function tarCommand(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const gitExe = which('git', env, platform)
    const roots = [gitExe && path.resolve(path.dirname(gitExe), '..'), env.ProgramFiles && path.join(env.ProgramFiles, 'Git')]
    for (const r of roots.filter(Boolean)) {
      const f = path.join(r, 'usr', 'bin', 'tar.exe')
      if (fs.existsSync(f)) return f
    }
  }
  return which('tar', env, platform)
}

function localTools(env = process.env) {
  return { ssh: sshCommand(env), tar: tarCommand(env), git: which('git', env) }
}

// ---- ssh ----

// A shell path with spaces is quoted for the login shell, which is cmd on a Windows server:
// "C:\Program Files\Git\bin\bash.exe" -s.
function remoteShell(shell) {
  const s = String(shell).trim()
  return /\s/.test(s) && !/["']/.test(s) ? `"${s}"` : s
}

function sshArgs(remote, ssh) {
  return [...ssh.slice(1), ...SSH_BASE, ...remote.sshOptions.flatMap(o => ['-o', o]), remote.host, `${remoteShell(remote.shell)} -s`]
}

function startSsh(remote, ssh) {
  return spawn(ssh[0], sshArgs(remote, ssh), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}

// Runs a script and collects its output. `pipeIn` (a readable stream) follows the script on stdin.
function exec(remote, script, { ssh, timeout = 60000, pipeIn = null, onChild } = {}) {
  return new Promise(resolve => {
    let child
    try {
      child = startSsh(remote, ssh)
    } catch (e) {
      return resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', error: e })
    }
    if (onChild) onChild(child)
    const out = []
    const err = []
    let timedOut = false
    let spawnError = null
    const timer = timeout ? setTimeout(() => { timedOut = true; child.kill() }, timeout) : null
    child.stdout.on('data', d => out.push(d))
    child.stderr.on('data', d => err.push(d))
    child.stdin.on('error', () => {})
    child.on('error', e => (spawnError = e))
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), timedOut, error: spawnError })
    })
    child.stdin.write(script)
    if (pipeIn) pipeIn.pipe(child.stdin)
    else child.stdin.end()
  })
}

function execSync(remote, script, { ssh, timeout = 30000 } = {}) {
  const r = spawnSync(ssh[0], sshArgs(remote, ssh), { input: script, timeout, windowsHide: true, maxBuffer: 1 << 26 })
  return { code: r.status, stdout: r.stdout || Buffer.alloc(0), stderr: String(r.stderr || ''), timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'), error: r.error && r.error.code !== 'ETIMEDOUT' ? r.error : null }
}

// [key, value] pairs from the `@@bulkhead-<token> key value` lines in some output.
function marks(text, tok) {
  const pre = `@@bulkhead-${tok} `
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(pre)
    if (i < 0) continue
    const rest = line.slice(i + pre.length)
    const sp = rest.indexOf(' ')
    out.push(sp < 0 ? [rest, ''] : [rest.slice(0, sp), rest.slice(sp + 1)])
  }
  return out
}

function lastLines(text, n = 2) {
  return String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('@@bulkhead-')).slice(-n).join(' / ')
}

// Why a connection failed, in one line.
function connectError(remote, r, timeoutMs) {
  if (r.error) return `could not start ssh: ${r.error.message}`
  if (r.timedOut) return `${remote.host} did not answer within ${Math.round(timeoutMs / 1000)}s`
  const said = lastLines(r.stderr)
  if (r.code === 255) return `ssh could not connect to ${remote.host}${said ? `: ${said}` : ''}`
  return `connected to ${remote.host}, but \`${remoteShell(remote.shell)} -s\` did not run (exit ${r.code})${said ? `: ${said}` : ''}. Check the remote's "shell" setting`
}

function parseMem(v) {
  const [free, total] = String(v || '').trim().split(/\s+/).map(Number)
  return total > 0 && Number.isFinite(free) ? { freeGb: free / 1024, totalGb: total / 1024 } : null
}

function readProbe(remote, r, tok, timeout) {
  const info = { refs: [], ok: false }
  for (const [k, v] of marks(r.stdout.toString('utf8'), tok)) {
    if (k === 'ref') info.refs.push(v)
    else info[k] = k === 'ok' ? true : v
  }
  info.mem = parseMem(info.mem)
  if (!info.ok) info.error = connectError(remote, r, timeout)
  return info
}

async function probe(remote, { ssh, project = '', sha = '', timeout = 45000 } = {}) {
  const tok = token()
  const t0 = Date.now()
  const r = await exec(remote, sh.probeScript({ token: tok, dir: remote.dir, project, sha }), { ssh, timeout })
  return { ...readProbe(remote, r, tok, timeout), ms: Date.now() - t0 }
}

function probeSync(remote, { ssh, timeout = 30000 } = {}) {
  const tok = token()
  const t0 = Date.now()
  const r = execSync(remote, sh.probeScript({ token: tok, dir: remote.dir }), { ssh, timeout })
  return { ...readProbe(remote, r, tok, timeout), ms: Date.now() - t0 }
}

// ---- the local repository ----

function git(args, cwd, { input, allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 1 << 30, windowsHide: true })
  if (r.error) throw new Failure(`git could not start: ${r.error.message}`, EXIT.TRANSFER)
  if (r.status !== 0 && !allowFail) throw new Failure(`git ${args.find(a => !a.startsWith('-'))} failed: ${lastLines(r.stderr, 1)}`, EXIT.TRANSFER)
  return r
}

function projectName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'project'
}

// Six hex digits that tell this clone apart from any other repository with the same folder
// name: a hash of this machine's name and the real path of the clone's git directory. It is
// saved in the clone's own git config the first time, so moving the folder or renaming the
// machine keeps it. Worktrees share the git directory, so they share the id and the copies.
// Two clones of one repository, here or on another machine, get different ids. The value is
// the same whoever computes it first, so two runs that start at once agree on it.
const ID_KEY = 'bulkhead.remoteid'
function repoId(commonDir, { host = os.hostname(), platform = process.platform, store = true } = {}) {
  const saved = git(['config', '--file', path.join(commonDir, 'config'), '--get', ID_KEY], commonDir, { allowFail: true }).stdout.trim()
  if (/^[0-9a-f]{6}$/.test(saved)) return saved
  let real = commonDir
  try { real = fs.realpathSync.native(commonDir) } catch {}
  // Windows and macOS file systems ignore case, and so does a path typed in another case
  if (platform === 'win32' || platform === 'darwin') real = real.toLowerCase()
  const id = crypto.createHash('sha256').update(`${String(host).toLowerCase()}\0${real}`).digest('hex').slice(0, 6)
  // a read-only repository still works; the id is then computed again on each run
  if (store) git(['config', '--file', path.join(commonDir, 'config'), ID_KEY, id], commonDir, { allowFail: true })
  return id
}

// The folder name on the remote: the repository's name and its id, or --project as given.
// A name ending in -<letter> would be taken for another project's copy of that letter.
function projectFor(repo, override) {
  if (override) {
    const p = projectName(override)
    if (/-[a-h]$/.test(p)) throw new Failure(`--project=${override}: a name ending in -a to -h is how copies b to h are named; pick another`, EXIT.USAGE)
    return p
  }
  return `${repo.name}-${repo.id}`
}

// Worktrees of one repository share the remote copies, so the name comes from the main checkout.
function repoInfo(cwd) {
  const r = git(['rev-parse', '--show-toplevel', '--git-common-dir', '--is-shallow-repository', '--show-prefix'], cwd, { allowFail: true })
  if (r.status !== 0) throw new Failure('not inside a git repository; bulkhead remote run sends the repository you are in', EXIT.USAGE)
  const [top, common, shallow, prefix = ''] = r.stdout.split('\n')
  const root = path.resolve(top)
  const commonDir = path.resolve(cwd, common)
  const base = path.basename(commonDir)
  const name = projectName(base === '.git' ? path.basename(path.dirname(commonDir)) : base.replace(/\.git$/, ''))
  const head = git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], cwd, { allowFail: true }).stdout.trim()
  return { root, name, id: repoId(commonDir), head, shallow: shallow.trim() === 'true', sub: prefix.trim().replace(/\/$/, '') }
}

// Tracked files that differ from HEAD (staged or not) and untracked files git does not ignore.
// Ignored files (.env, build output) never go unless named in --files.
function localChanges(root, platform = process.platform) {
  const split = s => s.split('\0').filter(Boolean)
  const diff = split(git(['diff', 'HEAD', '--name-only', '-z', '--no-renames', '--ignore-submodules=all'], root).stdout)
  const others = split(git(['ls-files', '-z', '--others', '--exclude-standard'], root).stdout)
  const changed = []
  const deleted = []
  let size = 0
  for (const f of new Set([...diff, ...others])) {
    let st
    try {
      st = fs.lstatSync(path.join(root, f))
    } catch {
      deleted.push(f)
      continue
    }
    // a nested repository: its files are not part of this one
    if (st.isDirectory()) continue
    changed.push(f)
    size += st.size
  }
  // A Windows checkout has no executable bit on disk, so the tar would drop it; git knows it.
  const executable = []
  if (platform === 'win32' && changed.length) {
    const want = new Set(changed)
    for (const e of split(git(['ls-files', '-s', '-z'], root).stdout)) {
      const m = /^100755 \S+ \d+\t([\s\S]*)$/.exec(e)
      if (m && want.has(m[1])) executable.push(m[1])
    }
  }
  return { changed, deleted, executable, size }
}

function extraFiles(list, cwd, root) {
  const out = []
  // git reports the real path; the current folder may be reached through a link (a subst
  // drive, a junction, macOS /tmp)
  const real = p => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
  const base = real(cwd)
  const top = real(root)
  for (const raw of list) {
    const abs = path.resolve(base, raw)
    const rel = path.relative(top, abs)
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Failure(`--files: ${raw} is not inside the repository ${root}`, EXIT.USAGE)
    const posix = rel.split(path.sep).join('/')
    // any case: on a Windows or macOS remote, .GIT would unpack over the copy's own .git
    if (/^\.git(?:\/|$)/i.test(posix)) throw new Failure(`--files: ${raw} is inside .git`, EXIT.USAGE)
    if (!fs.existsSync(abs)) throw new Failure(`--files: ${raw} does not exist`, EXIT.USAGE)
    out.push(posix)
  }
  return out
}

// Commits the remote reported that this repository also has: the bundle can leave them out.
function knownCommits(root, shas) {
  const valid = [...new Set(shas)].filter(s => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(s))
  if (!valid.length) return []
  const r = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], root, { input: valid.join('\n') + '\n' })
  return r.stdout.split('\n').map(l => l.trim().split(' ')).filter(p => p[1] === 'commit').map(p => p[0])
}

function waitClose(child, what) {
  return new Promise((resolve, reject) => {
    let err = ''
    if (child.stderr) child.stderr.on('data', d => (err += d))
    child.on('error', e => reject(new Failure(`${what} could not start: ${e.message}`, EXIT.TRANSFER)))
    child.on('close', code => (code === 0 ? resolve() : reject(new Failure(`${what} failed (exit ${code}): ${lastLines(err)}`, EXIT.TRANSFER))))
  })
}

// macOS tar adds a ._name entry for each file with extended attributes (a download's
// quarantine flag, a Finder tag), which a Linux remote would unpack as stray files.
function tarEnv(env = process.env) {
  return { ...env, COPYFILE_DISABLE: '1' }
}

// The file list goes to tar on stdin, NUL separated: no command line limit, and any file name.
async function tarFiles(tar, root, files, outFile) {
  const child = spawn(tar, ['-cf', '-', '--null', '-T', '-'], { cwd: root, windowsHide: true, env: tarEnv() })
  const done = waitClose(child, 'tar')
  const written = new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outFile)
    ws.on('error', reject)
    ws.on('finish', resolve)
    child.stdout.pipe(ws)
  })
  child.stdin.on('error', () => {})
  child.stdin.end(files.join('\0') + '\0')
  await Promise.all([done, written])
}

function rewriteNpmCi(cmd) {
  const out = cmd.replace(/(^|[\s;&|()])npm(\s+)(?:ci|clean-install|install-clean)(?=$|[\s;&|()])/g, '$1npm$2install --no-audit --no-fund')
  return { command: out, changed: out !== cmd }
}

// One argument is a shell line as typed; several are an argv, quoted back for the remote bash.
function commandLine(argv) {
  return argv.length === 1 ? argv[0] : argv.map(posixQuote).join(' ')
}

// ---- options ----

function optionValues(args, name) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) out.push(args[++i])
    else if (args[i].startsWith(`--${name}=`)) out.push(args[i].slice(name.length + 3))
  }
  return out
}
const opt = (args, name) => optionValues(args, name).pop()
const flag = (args, name) => args.includes(`--${name}`)
const list = (args, name) => optionValues(args, name).flatMap(v => v.split(',')).map(s => s.trim()).filter(Boolean)

function numberOpt(args, name, fallback, { min = 0, max = Infinity, integer = false } = {}) {
  const raw = opt(args, name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Failure(`--${name} should be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`, EXIT.USAGE)
  return n
}

// Arguments that are not options or option values.
function positional(args, valued = []) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      if (!a.includes('=') && valued.includes(a.slice(2)) && args[i + 1] !== undefined) i++
      continue
    }
    out.push(a)
  }
  return out
}

function pickRemote(cfg, name) {
  const all = cfg.values.remotes || {}
  const names = Object.keys(all)
  if (!names.length) {
    const why = cfg.warnings.filter(w => /remote|not valid JSON/.test(w)).map(w => `\n  config: ${w}`).join('')
    throw new Failure(`no remote is configured. Add one, for example:\n  bulkhead remote add buildbox dev@192.168.1.20 --ssh-option=IdentityFile=~/.ssh/buildbox${why}`, EXIT.USAGE)
  }
  if (name) {
    if (all[name]) return all[name]
    throw new Failure(`no remote named "${name}". Configured: ${names.join(', ')}`, EXIT.USAGE)
  }
  if (names.length === 1) return all[names[0]]
  const def = cfg.values['remote.default']
  if (def && all[def]) return all[def]
  if (def) throw new Failure(`remote.default is "${def}", which is not configured (${names.join(', ')}); pick one with --remote=NAME, or fix remote.default`, EXIT.USAGE)
  throw new Failure(`${names.length} remotes are configured (${names.join(', ')}); pick one with --remote=NAME, or set remote.default`, EXIT.USAGE)
}

// ---- state kept on this machine ----

function lastCopyFile(env) {
  return path.join(stateDir(env), 'remote-last.json')
}

function rememberCopy(env, key, letter) {
  try {
    const file = lastCopyFile(env)
    let obj = {}
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    obj[key] = letter
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj) + '\n')
  } catch {}
}

function lastCopy(env, key) {
  try {
    return JSON.parse(fs.readFileSync(lastCopyFile(env), 'utf8'))[key] || null
  } catch {
    return null
  }
}

function logDir(env) {
  return path.join(stateDir(env), 'remote-logs')
}

function openLog(env, project, now = new Date()) {
  const dir = logDir(env)
  fs.mkdirSync(dir, { recursive: true })
  const p = n => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`

  pruneLogs(dir, LOG_KEEP - 1)
  // 'wx' fails when the file exists, so two runs in the same second never share a log
  for (let i = 1; ; i++) {
    const file = path.join(dir, `${stamp}-${project}${i > 1 ? `-${i}` : ''}.log`)
    try {
      return { file, fd: fs.openSync(file, 'wx') }
    } catch (e) {
      if (e.code !== 'EEXIST' || i > 100) throw e
    }
  }
}

function pruneLogs(dir, keep = LOG_KEEP) {
  let names = []
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.log')).sort() } catch {}
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try { fs.unlinkSync(path.join(dir, n)) } catch {}
  }
}

// Keeps the last n lines of a stream of text.
function tailBuffer(n) {
  let lines = []
  let partial = ''
  return {
    push(text) {
      const parts = (partial + text).split('\n')
      partial = parts.pop()
      lines.push(...parts)
      if (lines.length > n * 4) lines = lines.slice(-n)
    },
    lines() {
      return [...lines, ...(partial ? [partial] : [])].slice(-n)
    },
  }
}

// ---- transfer ----

// Sends what the remote lacks: a bundle of the commits it does not have, and a tar of the
// uncommitted files. Both go in one ssh call, as a tar of the two files.
async function transfer({ remote, tools, repo, info, files, upload, signal }) {
  const result = { bundle: false, tar: false, bytes: 0 }
  const needBundle = info.head !== 'yes'
  if (!needBundle && !files.length) return result
  if (repo.shallow && needBundle) {
    throw new Failure('this repository is a shallow clone, which git cannot bundle. Run `git fetch --unshallow` once, then try again', EXIT.TRANSFER)
  }
  if (!tools.tar) throw new Failure('tar is not on PATH on this machine; it is needed to send changes', EXIT.TRANSFER)
  if (info.tar === 'none') throw new Failure(`tar is not installed on ${remote.name}`, EXIT.TRANSFER)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bulkhead-remote-'))
  signal.tmp = tmp
  try {
    const names = []
    if (needBundle) {
      const exclude = knownCommits(repo.root, info.refs)
      const r = git(['bundle', 'create', path.join(tmp, 'bundle'), 'HEAD', ...exclude.map(s => `^${s}`)], repo.root, { allowFail: true })
      if (r.status !== 0) throw new Failure(`git bundle create failed: ${lastLines(r.stderr)}`, EXIT.TRANSFER)
      names.push('bundle')
      result.bundle = true
      result.incremental = exclude.length > 0
    }
    if (files.length) {
      await tarFiles(tools.tar, repo.root, files, path.join(tmp, 'changes.tar'))
      names.push('changes.tar')
      result.tar = true
    }
    for (const n of names) result.bytes += fs.statSync(path.join(tmp, n)).size
    const outer = spawn(tools.tar, ['-cf', '-', ...names], { cwd: tmp, windowsHide: true, env: tarEnv() })
    const packed = waitClose(outer, 'tar')
    // when ssh fails first, the tar is killed and this rejects with nobody waiting for it
    packed.catch(() => {})
    const tok = token()
    const r = await exec(remote, sh.uploadScript({ token: tok, dir: remote.dir, id: upload }), {
      ssh: tools.ssh, timeout: 0, pipeIn: outer.stdout, onChild: c => (signal.child = c),
    })
    signal.child = null
    if (r.code !== 0) {
      outer.kill()
      if (r.code === 255 || r.error) throw new Failure(`sending to ${remote.name} failed: ${connectError(remote, r, 0)}`, EXIT.UNREACHABLE)
      throw new Failure(`sending to ${remote.name} failed (exit ${r.code}): ${lastLines(r.stderr)}`, EXIT.TRANSFER)
    }
    await packed
    return result
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    signal.tmp = null
  }
}

// ---- run ----

async function run(args, ctx) {
  const { env, cwd, stdout, stderr } = ctx
  const sep = args.indexOf('--')
  if (sep < 0 || sep === args.length - 1) throw new Failure(`bulkhead remote run needs a command after --\n${USAGE}`, EXIT.USAGE)
  const opts = args.slice(0, sep)
  const unknown = positional(opts, ['remote', 'gb', 'wait', 'files', 'tail', 'fetch', 'label', 'project'])
  if (unknown.length) throw new Failure(`unexpected ${unknown.join(' ')} before --; options are written --name=value`, EXIT.USAGE)
  const known = /^--(?:remote|gb|wait|files|tail|fetch|label|project)(?:=|$)/
  const bad = opts.filter(a => a.startsWith('--') && !known.test(a))
  if (bad.length) throw new Failure(`unknown option ${bad[0]}\n${USAGE}`, EXIT.USAGE)

  const cfg = config.load({ env, cwd })
  const remote = pickRemote(cfg, opt(opts, 'remote'))
  const gb = numberOpt(opts, 'gb', 0, { max: 1024 })
  const waitMin = numberOpt(opts, 'wait', 60, { max: 24 * 60 })
  const tail = numberOpt(opts, 'tail', 0, { max: 100000, integer: true })
  const fetchPaths = list(opts, 'fetch')
  const tools = localTools(env)
  if (!tools.ssh) throw new Failure('ssh is not on PATH. Install OpenSSH (Windows: Settings > Optional features > OpenSSH Client)', EXIT.UNREACHABLE)
  if (!tools.git) throw new Failure('git is not on PATH', EXIT.TRANSFER)

  const repo = repoInfo(cwd)
  if (!repo.head) throw new Failure('this repository has no commits yet; commit once, then run again', EXIT.TRANSFER)
  // git prints the real path; the home directory may be spelled through a link or a short name
  if (pathKey(repo.root, 'win32') === pathKey(os.homedir(), 'win32') || path.dirname(repo.root) === repo.root) {
    throw new Failure(`the repository root is ${repo.root}; bulkhead remote does not send a home directory or a drive root`, EXIT.USAGE)
  }
  const project = projectFor(repo, opt(opts, 'project'))
  const extra = extraFiles(list(opts, 'files'), cwd, repo.root)
  const changes = localChanges(repo.root)
  const files = [...new Set([...changes.changed, ...extra])]
  const npm = rewriteNpmCi(commandLine(args.slice(sep + 1)))
  const label = opt(opts, 'label') || args.slice(sep + 1).join(' ').replace(/\s+/g, ' ').slice(0, 80)

  const signal = { child: null, tmp: null, interrupted: false }
  const onSignal = name => {
    signal.interrupted = true
    if (signal.child) try { signal.child.kill() } catch {}
    if (signal.tmp) try { fs.rmSync(signal.tmp, { recursive: true, force: true }) } catch {}
    say(stderr, 'interrupted; the remote job stops when the connection closes')
    process.exit(128 + (os.constants.signals[name] || 2))
  }
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, onSignal)

  const t0 = Date.now()
  const info = await probe(remote, { ssh: tools.ssh, project, sha: repo.head })
  if (!info.ok) throw new Failure(`cannot reach ${remote.name} (${remote.host}): ${info.error}`, EXIT.UNREACHABLE)
  if (info.git === 'none') throw new Failure(`git is not installed on ${remote.name}, or not on PATH for ssh sessions`, EXIT.TRANSFER)
  if (info.writable === 'no') throw new Failure(`${info.dir} on ${remote.name} is not writable; set "dir" for this remote`, EXIT.TRANSFER)

  const upload = token()
  const sent = await transfer({ remote, tools, repo, info, files, upload, signal })
  const short = repo.head.slice(0, 7)
  const parts = [sent.bundle ? `sent ${short} (${sent.incremental ? 'new commits' : 'full history'}, ${bytes(sent.bytes)})` : `${short} already there`]
  parts.push(changes.changed.length ? `${plural(changes.changed.length, 'changed file')} (${bytes(changes.size)})` : 'no uncommitted changes')
  if (changes.deleted.length) parts.push(`${changes.deleted.length} deleted`)
  say(stderr, `${remote.name}: ${parts.join(', ')}`)
  if (extra.length) say(stderr, `also sent, though git may ignore them: ${extra.join(', ')}`)
  if (npm.changed) say(stderr, 'npm ci runs as npm install --no-audit --no-fund: the copies share node_modules, and npm ci would delete it under them')

  const tok = token()
  const script = sh.runScript({
    token: tok, dir: remote.dir, project, sha: repo.head, upload: sent.bundle || sent.tar ? upload : '', bundle: sent.bundle, tar: sent.tar,
    deleted: changes.deleted, executable: changes.executable, sub: repo.sub, command: npm.command, label, from: os.hostname(),
    gb, minFreeGb: remote.minFreeGb, maxJobs: remote.maxJobs, copies: remote.copies, waitSeconds: waitMin * 60,
    pollSeconds: Number(env.BULKHEAD_REMOTE_POLL) || 30, hold: fetchPaths.length > 0,
  })
  let logFile = null
  let log = null
  if (tail) {
    try {
      ({ file: logFile, fd: log } = openLog(env, project))
    } catch (e) {
      throw new Failure(`cannot write the log for --tail in ${logDir(env)}: ${e.message}`, EXIT.USAGE)
    }
  }
  const tb = tail ? tailBuffer(tail) : null
  const note = line => {
    say(stderr, line)
    if (log !== null) fs.writeSync(log, `[bulkhead remote] ${line}\n`)
  }
  const output = (stream, text) => {
    if (log === null) return stream.write(text)
    fs.writeSync(log, text)
    tb.push(text)
  }

  const child = startSsh(remote, tools.ssh)
  signal.child = child
  let exitCode = null
  let letter = null
  const holders = []
  const pre = `@@bulkhead-${tok} `
  let partial = ''
  const onMark = (key, value) => {
    if (key === 'waiting') note(`waiting: ${value} (up to ${waitMin} min)`)
    else if (key === 'reclaimed') note(`removed a stale lock, ${value}`)
    else if (key === 'repaired') note(`${remote.name}: ${value}`)
    else if (key === 'holder') holders.push(value.split('|'))
    else if (key === 'noroom') {
      const held = holders.map(([name, secs, from, lab]) => `${name} ${age(secs)}${from ? ` from ${from}` : ''}${lab ? `: ${lab}` : ''}`)
      note(`gave up after ${waitMin} min: ${value}${held.length ? `. Held: ${held.join('; ')}` : ''}`)
    } else if (key === 'fail') note(`${remote.name}: ${value}`)
    else if (key === 'portbusy') note(`port is already in use on ${remote.name} by pid ${value.trim()}; a server in the command may not start`)
    else if (key === 'portkill') note(`stopped pid ${value.trim()}, still listening on BULKHEAD_PORT after the command`)
    else if (key === 'start') {
      const [l, port, ...where] = value.split(' ')
      letter = l
      rememberCopy(env, `${remote.name}/${project}`, l)
      note(`${remote.name}  copy ${l}  ${where.join(' ')}  port ${port}`)
    } else if (key === 'exit') {
      const n = Number(value)
      exitCode = Number.isInteger(n) && n >= 0 && n <= 255 ? n : EXIT.TRANSFER
    }
    else if (key === 'hold') holdAndFetch()
  }
  const holdAndFetch = async () => {
    for (const p of fetchPaths) {
      const r = await fetchPath({ remote, tools, project, letter, sub: repo.sub, rel: p, dest: cwd })
      note(r.ok ? `fetched ${p}` : `could not fetch ${p}: ${r.error}`)
    }
    child.stdin.end()
  }
  const onErrText = text => {
    const lines = (partial + text).split('\n')
    partial = lines.pop()
    let pass = ''
    for (const line of lines) {
      const i = line.indexOf(pre)
      if (i < 0) { pass += line + '\n'; continue }
      if (i > 0) pass += line.slice(0, i)
      const rest = line.slice(i + pre.length).replace(/\r$/, '')
      const sp = rest.indexOf(' ')
      if (pass) { output(stderr, pass); pass = '' }
      onMark(sp < 0 ? rest : rest.slice(0, sp), sp < 0 ? '' : rest.slice(sp + 1))
    }
    // a partial line that cannot be the start of a marker goes out now, so progress bars show
    if (partial && !pre.startsWith(partial.slice(0, pre.length)) && !partial.includes(pre)) {
      pass += partial
      partial = ''
    }
    if (pass) output(stderr, pass)
  }
  if (tb) child.stdout.setEncoding('utf8')
  child.stdout.on('data', d => output(stdout, d))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', onErrText)
  child.stdin.on('error', () => {})
  // stdin stays open for the whole job: the remote side stops the job when it closes
  child.stdin.write(script)
  const code = await new Promise(resolve => {
    child.on('error', e => {
      note(`could not start ssh: ${e.message}`)
      resolve(EXIT.UNREACHABLE)
    })
    child.on('close', c => resolve(c))
  })
  if (partial) onErrText('\n')
  try { child.stdin.destroy() } catch {}
  signal.child = null
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(s, onSignal)

  let rc = exitCode
  if (rc === null) {
    if (code === 255) note(`lost the connection to ${remote.name}${letter ? '; the job on it stops when the remote notices' : ''}`)
    else note(`the remote side ended without a result (ssh exit ${code})`)
    rc = code === 255 || code === EXIT.UNREACHABLE ? EXIT.UNREACHABLE : code || EXIT.TRANSFER
  }
  if (tb) {
    fs.closeSync(log)
    const lines = tb.lines()
    stderr.write(`[bulkhead remote] ${lines.length === 1 ? 'last line' : `last ${lines.length} lines`} of output; full log: ${logFile}\n`)
    stdout.write(lines.join('\n') + (lines.length ? '\n' : ''))
  }
  say(stderr, `exit ${rc} after ${duration(Date.now() - t0)}${letter ? ` (copy ${letter})` : ''}`)
  return rc
}

// ---- fetch ----

// Streams one path out of a copy with tar, through ssh. Unlike scp, this needs no remote path
// syntax (C:/ or /c/), no quoting for the remote shell, and works the same on every server.
function fetchPath({ remote, tools, project, letter, sub, rel, dest }) {
  return new Promise(resolve => {
    if (!tools.tar) return resolve({ ok: false, code: EXIT.TRANSFER, error: 'tar is not on PATH on this machine' })
    const clean = String(rel).replace(/\\/g, '/').replace(/\/+$/, '')
    if (!clean || clean.split('/').includes('..') || /^\/|^[A-Za-z]:/.test(clean)) {
      return resolve({ ok: false, code: EXIT.USAGE, error: `${rel}: give a path inside the copy, relative to where the command ran` })
    }
    try { fs.mkdirSync(dest, { recursive: true }) } catch (e) {
      return resolve({ ok: false, code: EXIT.TRANSFER, error: `cannot create ${dest}: ${e.message}` })
    }
    const tok = token()
    const child = startSsh(remote, tools.ssh)
    let x = null
    let started = false
    let head = Buffer.alloc(0)
    let err = ''
    const marker = Buffer.from(`@@bulkhead-${tok} tar\n`)
    const startTar = rest => {
      started = true
      x = spawn(tools.tar, ['-xf', '-'], { cwd: dest, windowsHide: true })
      x.stdin.on('error', () => {})
      let xerr = ''
      x.stderr.on('data', d => (xerr += d))
      x.on('error', e => (xerr += e.message))
      // a tar that stops early (a full disk) never drains: stop the transfer instead of hanging
      x.on('close', c => {
        x.code = c === null ? 1 : c
        x.err = xerr
        child.stdout.resume()
        if (x.code !== 0 && child.exitCode === null) try { child.kill() } catch {}
      })
      if (rest.length) x.stdin.write(rest)
    }
    child.stdout.on('data', d => {
      if (started) {
        if (x.code !== undefined) return
        if (!x.stdin.write(d)) {
          child.stdout.pause()
          x.stdin.once('drain', () => child.stdout.resume())
        }
        return
      }
      head = Buffer.concat([head, d])
      const i = head.indexOf(marker)
      if (i >= 0) startTar(head.slice(i + marker.length))
    })
    child.stderr.on('data', d => (err += d))
    child.stdin.on('error', () => {})
    child.on('error', e => resolve({ ok: false, code: EXIT.UNREACHABLE, error: `could not start ssh: ${e.message}` }))
    child.on('close', code => {
      const fail = marks(err, tok).find(([k]) => k === 'fail')
      if (!started) {
        if (fail) return resolve({ ok: false, code: /does not exist in copy/.test(fail[1]) ? 1 : EXIT.TRANSFER, error: fail[1] })
        if (code === 255) return resolve({ ok: false, code: EXIT.UNREACHABLE, error: connectError(remote, { code, stderr: err }, 0) })
        return resolve({ ok: false, code: EXIT.TRANSFER, error: `the remote sent nothing (exit ${code}): ${lastLines(err)}` })
      }
      x.stdin.end()
      const finish = () => {
        if (code === 255) return resolve({ ok: false, code: EXIT.UNREACHABLE, error: `the transfer broke off: ${lastLines(err)}` })
        if (x.code !== 0) return resolve({ ok: false, code: EXIT.TRANSFER, error: `tar could not unpack (exit ${x.code}): ${lastLines(x.err)}` })
        if (code !== 0) return resolve({ ok: false, code: EXIT.TRANSFER, error: `the transfer broke off (exit ${code}): ${lastLines(err)}` })
        resolve({ ok: true, code: 0 })
      }
      if (x.code !== undefined && x.code !== null) finish()
      else x.on('close', () => setImmediate(finish))
    })
    child.stdin.end(sh.fetchScript({ token: tok, dir: remote.dir, project, letter, sub, path: clean }))
  })
}

async function fetchCmd(args, ctx) {
  const { env, cwd, stderr } = ctx
  const pos = positional(args, ['copy', 'remote', 'project'])
  const bad = args.filter(a => a.startsWith('--') && !/^--(?:copy|remote|project)(?:=|$)/.test(a))
  if (bad.length) throw new Failure(`unknown option ${bad[0]}`, EXIT.USAGE)
  if (!pos.length || pos.length > 2) throw new Failure('usage: bulkhead remote fetch <path> [<local dir>] [--copy=LETTER] [--remote=NAME] [--project=NAME]', EXIT.USAGE)
  const cfg = config.load({ env, cwd })
  const remote = pickRemote(cfg, opt(args, 'remote'))
  const tools = localTools(env)
  if (!tools.ssh) throw new Failure('ssh is not on PATH', EXIT.UNREACHABLE)
  // outside a repository, --project names the copies (`bulkhead remote status` lists them)
  let repo = { sub: '' }
  if (!opt(args, 'project')) {
    try {
      repo = repoInfo(cwd)
    } catch (e) {
      if (e.code !== EXIT.USAGE) throw e
      throw new Failure('not inside a git repository; run fetch inside the repository, or name its copies with --project=NAME (bulkhead remote status lists them)', EXIT.USAGE)
    }
  }
  else try { repo = repoInfo(cwd) } catch {}
  const project = projectFor(repo, opt(args, 'project'))
  const letter = opt(args, 'copy') || lastCopy(env, `${remote.name}/${project}`) || 'a'
  if (!/^[a-h]$/.test(letter)) throw new Failure('--copy should be a letter from a to h', EXIT.USAGE)
  const dest = path.resolve(cwd, pos[1] || '.')
  const r = await fetchPath({ remote, tools, project, letter, sub: repo.sub, rel: pos[0], dest })
  if (!r.ok) throw new Failure(`${remote.name}: ${r.error}`, r.code)
  say(stderr, `fetched ${pos[0]} from copy ${letter} on ${remote.name} into ${shortPath(dest)}`)
  return 0
}

// ---- status, list, add, remove ----

async function statusOf(remote, ssh, timeout = 30000) {
  const tok = token()
  const t0 = Date.now()
  const r = await exec(remote, sh.statusScript({ token: tok, dir: remote.dir }), { ssh, timeout })
  const out = { name: remote.name, host: remote.host, reachable: false, ms: Date.now() - t0, locks: [], copies: [] }
  for (const [k, v] of marks(r.stdout.toString('utf8'), tok)) {
    if (k === 'ok') out.reachable = true
    else if (k === 'dir') out.dir = v
    else if (k === 'mem') out.memory = parseMem(v)
    else if (k === 'copy') out.copies.push(v)
    else if (k === 'lock') {
      const [lock, secs, gbMb, from, stale, ...lab] = v.split('|')
      out.locks.push({ lock, ageSeconds: Number(secs) || 0, gb: Math.round(Number(gbMb) / 102.4) / 10 || 0, from, stale: stale || null, label: lab.join('|') })
    }
  }
  if (!out.reachable) out.error = connectError(remote, r, timeout)
  return out
}

async function statusCmd(args, ctx) {
  const { env, cwd, stdout } = ctx
  const cfg = config.load({ env, cwd })
  const all = Object.values(cfg.values.remotes || {})
  const name = opt(args, 'remote')
  const chosen = name ? [pickRemote(cfg, name)] : all
  if (!chosen.length) throw new Failure('no remote is configured; see bulkhead remote add --help', EXIT.USAGE)
  const tools = localTools(env)
  if (!tools.ssh) throw new Failure('ssh is not on PATH', EXIT.UNREACHABLE)
  const results = await Promise.all(chosen.map(r => statusOf(r, tools.ssh)))
  if (flag(args, 'json')) {
    stdout.write(JSON.stringify({ remotes: results }, null, 2) + '\n')
  } else {
    const color = useColor(stdout, env)
    const lines = []
    for (const s of results) {
      if (!s.reachable) {
        lines.push(`${paint(color, 'bold', s.name)}  ${s.host}  ${paint(color, 'red', 'unreachable')}: ${s.error}`, '')
        continue
      }
      const mem = s.memory ? `${s.memory.freeGb.toFixed(1)} of ${s.memory.totalGb.toFixed(1)} GB free` : 'free RAM unknown'
      lines.push(`${paint(color, 'bold', s.name)}  ${s.host}  ${paint(color, 'green', 'reachable')} in ${(s.ms / 1000).toFixed(1)}s  ${mem}  ${s.dir || ''}`)
      if (s.locks.length) {
        const rows = [['HELD', 'AGE', 'GB', 'FROM', 'LABEL']]
        for (const l of s.locks) rows.push([l.lock, age(l.ageSeconds), l.gb || '-', l.from || '?', `${l.label}${l.stale ? `  (stale: ${l.stale})` : ''}`])
        lines.push(...table(rows).map(l => `  ${l}`))
      } else lines.push('  nothing held')
      lines.push(`  copies: ${s.copies.length ? s.copies.join(', ') : 'none yet'}`, '')
    }
    stdout.write(lines.join('\n'))
  }
  return results.every(r => r.reachable) ? 0 : EXIT.UNREACHABLE
}

function listCmd(args, ctx) {
  const { env, cwd, stdout } = ctx
  const cfg = config.load({ env, cwd })
  const all = Object.values(cfg.values.remotes || {})
  const def = cfg.values['remote.default']
  if (flag(args, 'json')) {
    stdout.write(JSON.stringify({ default: def || null, remotes: all }, null, 2) + '\n')
    return 0
  }
  if (!all.length) {
    stdout.write('no remotes configured. Add one:\n  bulkhead remote add buildbox dev@192.168.1.20 --ssh-option=IdentityFile=~/.ssh/buildbox\n')
    return 0
  }
  const rows = [['NAME', 'HOST', 'SHELL', 'DIR', 'COPIES', 'JOBS', 'MIN FREE', 'SSH OPTIONS']]
  for (const r of all) {
    rows.push([r.name + (all.length > 1 && r.name === def ? ' *' : ''), r.host, r.shell, r.dir, r.copies, r.maxJobs, r.minFreeGb ? `${r.minFreeGb} GB` : '-', r.sshOptions.join(' ') || '-'])
  }
  stdout.write(table(rows).join('\n') + '\n')
  if (all.length > 1) stdout.write(def ? '* default\n' : 'no default: bulkhead remote run needs --remote=NAME\n')
  for (const w of cfg.warnings.filter(x => /remote/.test(x))) stdout.write(`WARN ${w}\n`)
  return 0
}

async function addCmd(args, ctx) {
  const { env, stdout, stderr } = ctx
  const valued = ['shell', 'dir', 'copies', 'max-jobs', 'min-free-gb', 'ssh-option']
  const pos = positional(args, valued)
  if (pos.length !== 2) throw new Failure('usage: bulkhead remote add <name> <user@host> [--shell=CMD] [--dir=PATH] [--copies=N] [--max-jobs=N] [--min-free-gb=N] [--ssh-option=KEY=VALUE]...', EXIT.USAGE)
  const known = /^--(?:shell|dir|copies|max-jobs|min-free-gb|ssh-option|default|no-check)(?:=|$)/
  const bad = args.filter(a => a.startsWith('--') && !known.test(a))
  if (bad.length) throw new Failure(`unknown option ${bad[0]}`, EXIT.USAGE)
  const [name, host] = pos
  const entry = { host }
  if (opt(args, 'shell') !== undefined) entry.shell = opt(args, 'shell')
  if (opt(args, 'dir') !== undefined) entry.dir = opt(args, 'dir')
  if (opt(args, 'copies') !== undefined) entry.copies = Number(opt(args, 'copies'))
  if (opt(args, 'max-jobs') !== undefined) entry.maxJobs = Number(opt(args, 'max-jobs'))
  if (opt(args, 'min-free-gb') !== undefined) entry.minFreeGb = Number(opt(args, 'min-free-gb'))
  const sshOptions = optionValues(args, 'ssh-option')
  if (sshOptions.length) entry.sshOptions = sshOptions
  const file = config.globalFile(env)
  let res
  try {
    res = remotes.addRemote(file, name, entry, { makeDefault: flag(args, 'default') })
  } catch (e) {
    throw new Failure(e.message, EXIT.USAGE)
  }
  stdout.write(`${res.existed ? 'updated' : 'added'} remote ${name} (${host}) in ${shortPath(file)}\n`)
  if (flag(args, 'no-check')) return 0
  const tools = localTools(env)
  if (!tools.ssh) {
    stderr.write('WARN ssh is not on PATH on this machine; bulkhead remote cannot connect until it is\n')
    return 0
  }
  const p = await probe(res.remote, { ssh: tools.ssh, timeout: 30000 })
  stdout.write(describeProbe(res.remote, p).line + '\n')
  return 0
}

function removeCmd(args, ctx) {
  const { env, stdout } = ctx
  const pos = positional(args)
  if (pos.length !== 1) throw new Failure('usage: bulkhead remote remove <name>', EXIT.USAGE)
  const file = config.globalFile(env)
  let found
  try {
    found = remotes.removeRemote(file, pos[0])
  } catch (e) {
    throw new Failure(e.message, EXIT.USAGE)
  }
  if (!found) throw new Failure(`no remote named "${pos[0]}" in ${shortPath(file)}`, EXIT.USAGE)
  stdout.write(`removed remote ${pos[0]} from ${shortPath(file)}. Copies on that machine are left in place.\n`)
  return 0
}

// One line for doctor and add: is this remote usable, and if not, why.
function describeProbe(remote, p) {
  if (!p.ok) return { status: 'FAIL', line: `${remote.name}: ${p.error}` }
  const missing = []
  if (p.git === 'none') missing.push('git')
  if (p.tar === 'none') missing.push('tar')
  const facts = [
    `${remote.host} reachable in ${(p.ms / 1000).toFixed(1)}s`,
    p.bash ? `bash ${String(p.bash).split('(')[0]}` : null,
    p.git && p.git !== 'none' ? String(p.git).replace(/^git version /, 'git ') : null,
    p.tar === 'yes' ? 'tar' : null,
    p.dir ? `${p.dir} ${p.writable === 'yes' ? 'writable' : 'NOT writable'}` : null,
    p.mem ? `${p.mem.freeGb.toFixed(1)} of ${p.mem.totalGb.toFixed(1)} GB free` : null,
  ].filter(Boolean)
  if (missing.length) return { status: 'FAIL', line: `${remote.name}: ${facts.join(', ')}; missing on the remote: ${missing.join(', ')}` }
  if (p.writable !== 'yes') return { status: 'FAIL', line: `${remote.name}: ${facts.join(', ')}` }
  return { status: 'OK', line: `${remote.name}: ${facts.join(', ')}` }
}

// ---- entry ----

const COMMANDS = { run, fetch: fetchCmd, status: statusCmd, list: listCmd, add: addCmd, remove: removeCmd, rm: removeCmd }

async function dispatch(argv, ctx) {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    ;(cmd ? ctx.stdout : ctx.stderr).write(USAGE + '\n')
    return cmd ? 0 : EXIT.USAGE
  }
  if (!COMMANDS[cmd]) throw new Failure(`unknown subcommand "${cmd}"\n${USAGE}`, EXIT.USAGE)
  if (rest[0] === '--help' || rest[0] === '-h') {
    ctx.stdout.write(USAGE + '\n')
    return 0
  }
  return COMMANDS[cmd](rest, ctx)
}

function main(argv, ctx = {}) {
  const c = { env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, ...ctx }
  return Promise.resolve()
    .then(() => dispatch(argv, c))
    .then(
      code => code,
      e => {
        if (!(e instanceof Failure)) throw e
        say(c.stderr, e.message)
        return e.code
      },
    )
    .then(code => {
      // let piped output drain before exiting
      if (!ctx.noExit) c.stdout.write('', () => process.exit(code || 0))
      return code
    })
}

module.exports = {
  main, USAGE, EXIT, sshArgs, remoteShell, which, sshCommand, tarCommand, tarEnv, localTools, rewriteNpmCi, commandLine, projectName, projectFor, repoId, repoInfo,
  localChanges, extraFiles, knownCommits, marks, pickRemote, probeSync, describeProbe, tailBuffer, pruneLogs, positional,
}
