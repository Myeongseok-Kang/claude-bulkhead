'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

// On Windows the desktop app and the CLI are both claude.exe. The app's processes run from
// ...\app\Claude.exe (or Claude.app on macOS) and its helpers carry --type=.
const DESKTOP_APP = /[\\/]app[\\/]Claude\.exe|Claude\.app[\\/]Contents[\\/]MacOS[\\/]Claude(?:["\s]|$)/i
const PID_REUSE_SLACK_MS = 120 * 1000

// The native installer runs versions/<x.y.z> through a `claude` link, so the process name can be
// the version; the command line still starts with claude or names that folder.
function isClaudeCli(p) {
  if (!p) return false
  if (/--type=/.test(p.cmd) || DESKTOP_APP.test(p.cmd)) return false
  if (/^claude(?:\.exe)?$/i.test(p.name)) return true
  if (/^["']?(?:\S*[\\/])?claude(?:\.exe)?["']?(?:\s|$)|[\\/]claude[\\/]versions[\\/]/i.test(p.cmd)) return true
  return /^(?:node|bun)(?:\.exe)?$/i.test(p.name) && /claude-code[\\/]cli\.js|@anthropic-ai[\\/]claude-code/i.test(p.cmd)
}

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

// Claude Code writes ~/.claude/sessions/<pid>.json with the session's cwd and start time.
function readSessionFiles(dir = path.join(claudeDir(), 'sessions')) {
  const files = new Map()
  let names = []
  try { names = fs.readdirSync(dir) } catch {}
  for (const name of names.filter(n => /^\d+\.json$/.test(n))) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (s.pid) files.set(Number(s.pid), { cwd: s.cwd || null, startedAt: Number(s.startedAt) || 0, status: s.status || null, sessionId: s.sessionId || null })
    } catch {}
  }
  return files
}

function linuxCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`) } catch { return null }
}

// Maps every process to the session whose tree it is in. A child must be younger than its
// parent, which skips Windows children whose parent PID was reused. On Linux a server that
// outlived its shell is still matched through CLAUDE_PID.
function assignOwners(procs, sessionPids) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const kids = new Map()
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, [])
    kids.get(p.ppid).push(p)
  }
  const owner = new Map()
  for (const root of sessionPids) {
    const queue = [byPid.get(root)]
    owner.set(root, root)
    for (let i = 0; i < queue.length; i++) {
      for (const c of kids.get(queue[i].pid) || []) {
        if (owner.has(c.pid) || sessionPids.has(c.pid) || c.start < queue[i].start) continue
        owner.set(c.pid, root)
        queue.push(c)
      }
    }
  }
  // the shell snapshots each live session is seen using through its own tree
  const known = new Map()
  for (const [pid, root] of owner) {
    const ms = snapshotMs(byPid.get(pid).cmd)
    if (!ms) continue
    if (!known.has(root)) known.set(root, new Set())
    known.get(root).add(ms)
  }
  for (const p of procs) {
    if (owner.has(p.pid)) continue
    const s = byPid.get(p.claudePid)
    if (sessionPids.has(p.claudePid) && p.start >= s.start) owner.set(p.pid, p.claudePid)
    else {
      const bySnapshot = snapshotOwner(p, byPid, sessionPids, known)
      if (bySnapshot) owner.set(p.pid, bySnapshot)
    }
  }
  return owner
}

function snapshotMs(cmd) {
  const m = /shell-snapshots[\\/]snapshot-\w+-(\d{13})-/.exec(cmd)
  return m ? Number(m[1]) : 0
}

// Windows: a server started with `&` loses its parent when the tool shell's wrapper exits.
// The Claude shell above it still names the session's shell snapshot. Claude Code writes it at
// the session's first Bash call, which can be minutes after the start, so any session started
// before it may own it. A session uses one snapshot, so one seen using another is ruled out.
// We only use it when exactly one session is left.
function snapshotOwner(p, byPid, sessionPids, known = new Map()) {
  let cur = p
  let ms = 0
  for (let i = 0; cur && i < 30 && !ms; i++) {
    ms = snapshotMs(cur.cmd)
    const par = byPid.get(cur.ppid)
    cur = par && par.start <= cur.start ? par : null
  }
  if (!ms) return null
  for (const [pid, set] of known) if (set.has(ms)) return pid
  const fits = [...sessionPids].filter(pid => byPid.get(pid).start <= ms + 5000 && !known.has(pid))
  return fits.length === 1 ? fits[0] : null
}

// [{ pid, start, cwd, rss, ports: [{ port, pid, name }] }], oldest first.
function findSessions({ procs, ports = [] }, files = new Map(), cwdOf = process.platform === 'linux' ? linuxCwd : () => null) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const roots = procs.filter(isClaudeCli)
  const owner = assignOwners(procs, new Set(roots.map(p => p.pid)))
  return roots.sort((a, b) => a.start - b.start).map(p => {
    const f = files.get(p.pid)
    const fileMatches = f && (!f.startedAt || !p.start || Math.abs(f.startedAt - p.start) < PID_REUSE_SLACK_MS)
    let rss = 0
    let children = 0
    for (const [pid, root] of owner) {
      if (root !== p.pid) continue
      rss += byPid.get(pid).rss || 0
      if (pid !== p.pid) children++
    }
    return {
      pid: p.pid,
      start: p.start,
      cwd: (fileMatches && f.cwd) || cwdOf(p.pid),
      rss,
      children,
      ports: ports.filter(l => owner.get(l.pid) === p.pid).map(l => ({ ...l, name: byPid.get(l.pid).name })),
    }
  })
}

// The session a process runs under: its nearest Claude ancestor, or CLAUDE_PID.
function ownSession(procs, pid = process.pid, env = process.env) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  let cur = byPid.get(pid)
  for (let i = 0; cur && i < 40; i++) {
    if (isClaudeCli(cur)) return cur.pid
    const par = byPid.get(cur.ppid)
    cur = par && par.start <= cur.start ? par : null
  }
  return Number(env.CLAUDE_PID) || null
}

module.exports = { isClaudeCli, readSessionFiles, findSessions, assignOwners, ownSession, claudeDir }
