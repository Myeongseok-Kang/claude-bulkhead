'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { stateDir, log } = require('./hook')
const { readMemory } = require('./memory')
const { take, release, readSlots, staleReason, slotDir, admit, queueDir, enqueue } = require('./slots')

const USAGE = `usage:
  bulkhead-slot run [--gb=N] [--wait=MINUTES] [--label=TEXT] -- <command...>
  bulkhead-slot status [--gb=N]

run waits until the machine has room for a job of N GB (default 3), runs the
command, and releases the slot when it exits, even on failure. The exit code is
the command's. status shows who holds slots and whether a new job would start.`

function option(args, name, fallback) {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function gbOption(args) {
  const n = Number(option(args, 'gb', 3))
  return n > 0 && n <= 256 ? n : 3
}

function findGitBash(env = process.env, exists = fs.existsSync) {
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ]
  return candidates.find(f => f && exists(f)) || null
}

const posixQuote = a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
const cmdQuote = a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)

// One argument is a shell line as typed; several are an argv we quote back together,
// so `-- bash -c "a && b"` keeps its quotes.
function shellCommand(args, platform = process.platform, gitBash = null) {
  if (platform === 'win32' && !gitBash) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', args.length === 1 ? args[0] : args.map(cmdQuote).join(' ')] }
  }
  const line = args.length === 1 ? args[0] : args.map(posixQuote).join(' ')
  return { file: platform === 'win32' ? gitBash : '/bin/sh', args: ['-c', line] }
}

function measure(withCommit) {
  return readMemory({ withCommit })
}

function run(args) {
  const sep = args.indexOf('--')
  if (sep < 0 || sep === args.length - 1) {
    console.error(USAGE)
    return process.exit(1)
  }
  const opts = args.slice(0, sep)
  const command = args.slice(sep + 1)
  const gb = gbOption(opts)
  const label = option(opts, 'label', command.join(' ').slice(0, 80))
  const deadline = Date.now() + Number(option(opts, 'wait', 30)) * 60000
  const dir = slotDir(stateDir())
  let announced = false
  let queued = null
  const unqueue = () => {
    if (queued) try { fs.unlinkSync(queued) } catch {}
    queued = null
  }
  process.on('exit', unqueue)

  const attempt = () => {
    const got = take(dir, { label, gb, pid: process.pid }, measure, (slot, why) => log('slot', `reclaimed ${slot.label}: ${why}`))
    if (got.file) {
      unqueue()
      return start(got.file)
    }
    if (Date.now() > deadline) {
      console.error(`[bulkhead-slot] gave up waiting: ${got.reason}. Holders: ${holders(dir)}`)
      return process.exit(3)
    }
    if (!announced) {
      console.error(`[bulkhead-slot] waiting: ${got.reason}. Holders: ${holders(dir)}`)
      announced = true
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130))
    }
    queued = enqueue(queueDir(stateDir()), { label, gb, pid: process.pid, at: queuedAt, reason: got.reason })
    setTimeout(attempt, 15000)
  }
  const queuedAt = Date.now()

  const start = file => {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeAllListeners(sig)
    console.error(`[bulkhead-slot] running ${label} (${gb} GB)`)
    const { file: shell, args: shellArgs } = shellCommand(command, process.platform, process.platform === 'win32' ? findGitBash() : null)
    const child = spawn(shell, shellArgs, { stdio: 'inherit', windowsHide: true })
    const done = code => {
      release(file)
      process.exit(code)
    }
    child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)))
    child.on('error', e => {
      console.error(`[bulkhead-slot] could not start: ${e.message}`)
      done(1)
    })
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => {
        try { child.kill(sig) } catch {}
        done(1)
      })
    }
  }

  attempt()
}

function holders(dir) {
  return readSlots(dir).map(s => `${s.label} (${s.gb} GB, pid ${s.pid})`).join(', ') || 'none'
}

function status(args) {
  const dir = slotDir(stateDir())
  const gb = gbOption(args)
  const held = readSlots(dir)
  if (!held.length) console.log('no slots held')
  for (const s of held) {
    const why = staleReason(s)
    const mins = Math.round((Date.now() - s.at) / 60000)
    console.log(`${path.basename(s.file)}: ${s.label} (${s.gb} GB, pid ${s.pid}, ${mins} min)${why ? ` stale: ${why}` : ''}`)
  }
  const live = held.filter(s => !staleReason(s))
  const mem = measure(live.length > 0)
  const reason = admit({ held: live, mem, gb })
  const commit = mem.commitPct == null ? '' : `, commit ${mem.commitPct}%`
  console.log(`free ${mem.freeGb.toFixed(1)} of ${mem.totalGb.toFixed(1)} GB${commit}. A ${gb} GB job would ${reason ? `wait: ${reason}` : 'start now'}.`)
}

function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'run') return run(rest)
  if (cmd === 'status') return status(rest)
  console.error(USAGE)
  process.exit(cmd === '--help' || cmd === '-h' ? 0 : 1)
}

if (require.main === module) main(process.argv.slice(2))

module.exports = { main, shellCommand, findGitBash }
