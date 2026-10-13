'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { runHook, blocked, oneLine } = require('./hook')
const { readSessionFiles } = require('./sessions')
const shell = require('./shell')

// The git commands a line runs on this machine, wrappers (bash -c, env, VAR=value) opened.
function gitCommands(cmd, mode = 'sh') {
  return shell.commands(shell.prepare(String(cmd || ''), mode), mode).filter(c => !c.remote && shell.bin(c.argv[0]) === 'git')
}

// git <sub> args, with -C <dir> pulled out. Returns null for anything that is not git.
// Takes the words of one command, or a command line (read as its first command).
function gitCall(seg, cwd) {
  const t = Array.isArray(seg) ? seg : ((shell.commands(seg)[0] || {}).argv || [])
  if (shell.bin(t[0] || '') !== 'git') return null
  let dir = cwd
  const rest = []
  for (let i = 1; i < t.length; i++) {
    if (t[i] === '-C' && t[i + 1]) dir = path.resolve(dir, t[++i])
    else if (t[i] === '-c') i++
    else rest.push(t[i])
  }
  return { dir, sub: rest[0], args: rest.slice(1) }
}

const DONE = /^--(?:abort|continue|skip|quit)$/

// What the command does to a shared working tree, or null when it leaves it alone.
// 'dirty-only' means it matters only when there are uncommitted changes.
function changesTree({ sub, args, dir = '.' }, exists = fs.existsSync) {
  const paths = args.indexOf('--') >= 0 ? args.slice(args.indexOf('--') + 1) : []
  switch (sub) {
    case 'checkout': {
      if (paths.length) return paths.includes('.') ? 'restores every file' : null
      if (args.includes('-')) return 'switches the branch'
      const names = args.filter(a => !a.startsWith('-'))
      if (names.includes('.')) return 'restores every file'
      // git checkout src/app.js restores a file; only a branch or commit moves the tree
      if (!args.some(a => /^-[bB]$/.test(a)) && names.length && names.every(n => exists(path.resolve(dir, n)))) return null
      return names.length ? 'switches the branch' : null
    }
    case 'switch':
      return 'switches the branch'
    case 'restore': {
      // --staged alone only unstages; the files on disk stay as they are
      const staged = args.some(a => a === '--staged' || /^-[a-zA-Z]*S/.test(a))
      const worktree = args.some(a => a === '--worktree' || /^-[a-zA-Z]*W/.test(a))
      if (staged && !worktree) return null
      return args.includes('.') ? 'restores every file' : null
    }
    case 'stash':
      return !args[0] || /^(?:push|save|pop|apply|-u|--include-untracked|-k|--keep-index|-m)$/.test(args[0]) ? 'stashes or unstashes changes' : null
    case 'reset':
      return args.includes('--hard') ? 'resets the files' : null
    case 'clean':
      if (args.some(a => /^-[a-z]*n/.test(a) || a === '--dry-run')) return null
      return args.some(a => /^-[a-z]*f/.test(a) || a === '--force') ? 'deletes untracked files' : null
    case 'rebase':
      return args.some(a => DONE.test(a)) ? null : 'rebases the branch'
    case 'merge':
      return args.some(a => DONE.test(a)) ? null : 'merges into the branch'
    case 'pull':
      return 'dirty-only'
    default:
      return null
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// git prints the real path of the tree; a session may have started through a symlink, a junction
// or a Windows short name (C:\Users\RUNNER~1), so both sides are resolved before comparing.
const real = p => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
const key = (p, platform) => {
  const n = real(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? n.toLowerCase() : n
}
const inside = (child, parent) => child === parent || child.startsWith(parent + '/')

// Other live sessions whose project directory is in the same working tree. A session started in
// a subfolder of this tree could still be in a nested worktree or submodule, so git decides those.
function sharers(top, sessionId, { files, isAlive, run, platform }) {
  const topKey = key(top, platform)
  const out = []
  for (const [pid, f] of files) {
    if (!f.cwd || f.sessionId === sessionId || !isAlive(pid)) continue
    const cwdKey = key(f.cwd, platform)
    if (!inside(cwdKey, topKey)) continue
    if (cwdKey !== topKey) {
      let theirs
      try { theirs = run(['rev-parse', '--show-toplevel'], f.cwd) } catch { continue }
      if (key(theirs, platform) !== topKey) continue
    }
    out.push({ pid, ...f })
  }
  return out
}

function when(ms) {
  if (!ms) return 'unknown time'
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function check(cmd, {
  cwd = process.cwd(), sessionId = null, files = () => readSessionFiles(), isAlive = alive, run = git, platform = process.platform, mode = 'sh',
} = {}) {
  if (!sessionId) return null
  for (const c of gitCommands(cmd, mode)) {
    const call = gitCall(c.argv, cwd)
    const seg = c.argv.join(' ')
    if (!call) continue
    let what = changesTree(call)
    if (!what) continue
    const live = new Map([...files()].filter(([pid, f]) => f.cwd && f.sessionId !== sessionId && isAlive(pid)))
    if (!live.size) continue
    let top
    try { top = run(['rev-parse', '--show-toplevel'], call.dir) } catch { continue }
    const others = sharers(top, sessionId, { files: live, isAlive, run, platform })
    if (!others.length) continue
    if (what === 'dirty-only') {
      let status = ''
      try { status = run(['status', '--porcelain', '--untracked-files=no'], call.dir) } catch { continue }
      if (!status) continue
      what = 'merges into a tree with uncommitted changes'
    }
    const o = others[0]
    const name = path.basename(top)
    return `[bulkhead] checkout-guard: \`${oneLine(seg, 120)}\` ${what} in ${top}, ` +
      `and another Claude session works in the same tree (pid ${o.pid}, started ${when(o.startedAt)}` +
      (others.length > 1 ? `, and ${others.length - 1} more` : '') + ').\n' +
      'Its files and branch would change under it. Work in your own worktree instead:\n' +
      `  git worktree add ../${name}-<task> -b <branch>`
  }
  return null
}

if (require.main === module) {
  runHook('checkout-guard', input => {
    const cmd = input.tool_input && input.tool_input.command
    if (!cmd) return
    const mode = shell.modeFor(input)
    const why = check(cmd, { cwd: input.cwd || process.cwd(), sessionId: input.session_id || null, mode })
    if (!why) return
    return blocked('checkout-guard', ruleOf(cmd, input.cwd || process.cwd(), mode), input, why)
  })
}

// `git-checkout`, `git-stash` and so on: the first git command that moves the tree.
function ruleOf(cmd, cwd = '.', mode = 'sh') {
  for (const c of gitCommands(cmd, mode)) {
    const call = gitCall(c.argv, cwd)
    if (call && changesTree(call)) return `git-${call.sub}`
  }
  return 'git'
}

module.exports = { check, changesTree, gitCall, ruleOf }
