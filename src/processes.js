'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// Every reader returns { procs: [{ pid, ppid, name, cmd, start, rss, claudePid }], listening: Set<pid>,
// ports: [{ port, pid }] }. start is milliseconds since the epoch, rss is bytes, and claudePid is null
// when the environment is unreadable.

const WINDOWS_QUERY = `
$procs = Get-CimInstance Win32_Process | ForEach-Object {
  $t = 0; if ($_.CreationDate) { $t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }
  [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine; start = $t; rss = $_.WorkingSetSize }
}
$listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = $_.OwningProcess; port = $_.LocalPort } })
[pscustomobject]@{ procs = @($procs); listen = $listen } | ConvertTo-Json -Compress -Depth 3
`

// IPv4 and IPv6 sockets on the same port show up twice.
function uniquePorts(list) {
  const seen = new Map()
  for (const l of list) seen.set(`${l.pid}:${l.port}`, { port: Number(l.port), pid: Number(l.pid) })
  return [...seen.values()].sort((a, b) => a.port - b.port)
}

function parseWindows(json) {
  const data = JSON.parse(json)
  const procs = [].concat(data.procs || []).map(p => ({
    pid: p.pid, ppid: p.ppid, name: p.name || '', cmd: p.cmd || '', start: Number(p.start) || 0, rss: Number(p.rss) || 0, claudePid: null,
  }))
  const ports = uniquePorts([].concat(data.listen || []))
  return { procs, listening: new Set(ports.map(l => l.pid)), ports }
}

function readWindows(run = execFileSync) {
  const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY],
    { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
  return parseWindows(out)
}

// /proc/<pid>/stat: "pid (comm) state ppid ... starttime(22nd field) vsize rss(24th, in pages)".
// comm may contain spaces and parens.
function parseProcStat(text) {
  const close = text.lastIndexOf(')')
  const name = text.slice(text.indexOf('(') + 1, close)
  const rest = text.slice(close + 2).split(' ')
  return { name, ppid: Number(rest[1]), startTicks: Number(rest[19]), rssPages: Number(rest[21]) || 0 }
}

// Socket inode -> local port for sockets in LISTEN state (0A) from /proc/net/tcp and tcp6.
function parseNetTcp(text) {
  const inodes = new Map()
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length > 9 && f[3] === '0A') inodes.set(f[9], parseInt(f[1].split(':').pop(), 16))
  }
  return inodes
}

function envValue(environ, key) {
  for (const kv of environ.split('\0')) if (kv.startsWith(key + '=')) return kv.slice(key.length + 1)
  return null
}

const realFs = {
  read: p => fs.readFileSync(p, 'utf8'),
  list: p => fs.readdirSync(p),
  link: p => fs.readlinkSync(p),
}

function readLinux(io = realFs, clockTicks = 100, pageSize = 4096) {
  const bootMs = Number(io.read('/proc/stat').match(/^btime (\d+)/m)[1]) * 1000
  const tryRead = p => { try { return io.read(p) } catch { return null } }
  const listenInodes = new Map()
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const t = tryRead(f)
    if (t) for (const [inode, port] of parseNetTcp(t)) listenInodes.set(inode, port)
  }
  const procs = []
  const ports = []
  for (const entry of io.list('/proc').filter(e => /^\d+$/.test(e))) {
    const stat = tryRead(`/proc/${entry}/stat`)
    if (!stat) continue
    const pid = Number(entry)
    const s = parseProcStat(stat)
    const argv = (tryRead(`/proc/${entry}/cmdline`) || '').split('\0')
    const cmd = argv.join(' ').trim()
    // comm is the main thread's name, and Node 24 names its main thread "MainThread": a node
    // process, Claude Code's included, would no longer read as node. argv[0] names the program.
    if (s.name === 'MainThread' && argv[0]) s.name = path.posix.basename(argv[0])
    const environ = tryRead(`/proc/${entry}/environ`)
    const claudePid = environ && Number(envValue(environ, 'CLAUDE_PID'))
    procs.push({
      pid, ppid: s.ppid, name: s.name, cmd, start: bootMs + (s.startTicks / clockTicks) * 1000,
      rss: s.rssPages * pageSize, claudePid: claudePid || null,
    })
    if (!listenInodes.size) continue
    let fds = []
    try { fds = io.list(`/proc/${entry}/fd`) } catch {}
    for (const fd of fds) {
      let target = ''
      try { target = io.link(path.posix.join(`/proc/${entry}/fd`, fd)) } catch {}
      const m = /^socket:\[(\d+)\]$/.exec(target)
      if (m && listenInodes.has(m[1])) ports.push({ pid, port: listenInodes.get(m[1]) })
    }
  }
  const unique = uniquePorts(ports)
  return { procs, listening: new Set(unique.map(l => l.pid)), ports: unique }
}

// `ps -o pid=,ppid=,rss=,lstart=,args=`: lstart is always five words, e.g. "Mon Oct 13 09:12:01 2026".
function parsePs(text, names = new Map()) {
  const procs = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+ +\w+ +\d+ +[\d:]+ +\d+)\s*(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const cmd = m[5].trim()
    procs.push({
      pid, ppid: Number(m[2]), name: names.get(pid) || path.basename(cmd.split(' ')[0] || ''), cmd,
      start: new Date(m[4].replace(/ +/g, ' ')).getTime() || 0, rss: Number(m[3]) * 1024, claudePid: null,
    })
  }
  return procs
}

// `lsof -nP -iTCP -sTCP:LISTEN -Fn`: "p<pid>" starts a process, "n<addr>:<port>" names a socket.
function parseLsof(text) {
  const ports = []
  let pid = 0
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n') {
      const port = Number(line.slice(line.lastIndexOf(':') + 1))
      if (pid && port) ports.push({ pid, port })
    }
  }
  return uniquePorts(ports)
}

// `ps -E` appends each process's environment to its command line. macOS shows it only for the
// user's own processes, which are the only ones a Claude tool shell can start. A CLAUDE_PID that
// is not a whole word (no space or end after the digits) is ignored.
function parsePsEnv(text) {
  const out = new Map()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s.*\sCLAUDE_PID=(\d+)(?=\s|$)/.exec(line)
    if (m) out.set(Number(m[1]), Number(m[2]))
  }
  return out
}

function readMac(run = execFileSync, { withEnv = false } = {}) {
  const opts = { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }
  const names = new Map()
  for (const line of run('ps', ['-axo', 'pid=,ucomm='], opts).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m) names.set(Number(m[1]), m[2].trim())
  }
  const procs = parsePs(run('ps', ['-axww', '-o', 'pid=,ppid=,rss=,lstart=,args='], opts), names)
  if (withEnv) {
    let env = new Map()
    try { env = parsePsEnv(run('ps', ['-axwwE', '-o', 'pid=,command='], opts)) } catch {}
    for (const p of procs) p.claudePid = env.get(p.pid) || null
  }
  let ports = []
  // lsof exits 1 when nothing is listening
  try { ports = parseLsof(run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], opts)) } catch (e) { ports = parseLsof(String(e.stdout || '')) }
  return { procs, listening: new Set(ports.map(l => l.pid)), ports }
}

function readProcesses(platform = process.platform, { withEnv = false } = {}) {
  if (platform === 'win32') return readWindows()
  if (platform === 'linux') return readLinux()
  if (platform === 'darwin') return readMac(execFileSync, { withEnv })
  return null
}

module.exports = {
  readProcesses, parseWindows, readWindows, parseProcStat, parseNetTcp, readLinux, envValue, parsePs, parseLsof, readMac, parsePsEnv,
}
