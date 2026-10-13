'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync, execFileSync } = require('child_process')
const { stateDir } = require('./hook')
const config = require('./config')
const { logSize, readEvents } = require('./events')
const { readMemory } = require('./memory')
const { readProcesses } = require('./processes')
const { readSessionFiles, findSessions, claudeDir } = require('./sessions')
const { limits, readSlots, slotDir, staleReason } = require('./slots')
const { useColor, paint, shortPath, bytes } = require('./cli-util')
const remote = require('./remote')

const ROOT = path.resolve(__dirname, '..')
const SMALL_MACHINE_GB = 24

const ok = (id, summary) => ({ id, status: 'OK', summary })
const warn = (id, summary) => ({ id, status: 'WARN', summary })
const fail = (id, summary) => ({ id, status: 'FAIL', summary })

function checkNode(version = process.versions.node) {
  const major = Number(version.split('.')[0])
  return major >= 18 ? ok('node', `v${version}`) : fail('node', `v${version}; bulkhead needs Node 18 or later on PATH`)
}

function checkPlugin(root = ROOT) {
  const file = path.join(root, 'hooks', 'hooks.json')
  let hooks
  try {
    hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks
  } catch (e) {
    return fail('plugin', `${shortPath(file)} cannot be read: ${e.message}`)
  }
  const missing = []
  const counts = []
  for (const [event, groups] of Object.entries(hooks || {})) {
    let n = 0
    for (const g of groups) {
      for (const h of g.hooks || []) {
        n++
        for (const a of h.args || []) {
          const script = String(a).replace('${CLAUDE_PLUGIN_ROOT}', root)
          if (/\.js$/.test(script) && !fs.existsSync(script)) missing.push(path.relative(root, script))
        }
      }
    }
    counts.push(`${n} ${event}`)
  }
  if (missing.length) return fail('plugin', `hooks.json names scripts that are missing: ${missing.join(', ')}`)
  return ok('plugin', `${shortPath(root)}, hooks: ${counts.join(', ')}`)
}

function checkStateDir(dir = stateDir()) {
  const probe = path.join(dir, `.doctor-${process.pid}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return ok('state dir', `${shortPath(dir)} is writable`)
  } catch (e) {
    return fail('state dir', `${shortPath(dir)} is not writable (${e.code || e.message}); slots and the event log cannot work`)
  }
}

function checkConfig(cfg) {
  const files = [cfg.files.global, cfg.files.project].filter(f => f && fs.existsSync(f))
  const out = []
  if (!cfg.warnings.length) out.push(ok('config', files.length ? `loaded ${files.map(f => shortPath(f)).join(', ')}` : 'no config files, defaults in use'))
  for (const w of cfg.warnings) out.push(warn('config', w.replace(/^(\S+)/, m => shortPath(m))))
  return out
}

function why(source) {
  if (source === 'default') return 'default'
  if (source.startsWith('env ')) return source
  return shortPath(source)
}

function checkGuards(cfg, platform = process.platform) {
  const out = []
  for (const [name, section] of Object.entries(config.GUARDS)) {
    const key = `${section}.enabled`
    const on = cfg.values[key] !== false
    if (!on) {
      out.push(ok(name, `off (${why(cfg.sources[key])})`))
      continue
    }
    if (name === 'orphan-reaper' && !['win32', 'linux', 'darwin'].includes(platform)) {
      out.push(warn(name, `on, but ${platform} is not supported, so it does nothing`))
      continue
    }
    let note = 'on'
    if (name === 'basics') {
      const offRules = Object.entries(config.RULES).filter(([, k]) => cfg.values[k] === false).map(([r, k]) => `${r} off (${why(cfg.sources[k])})`)
      if (offRules.length) note += `, ${offRules.join(', ')}`
      note += `, protected branches: ${cfg.values['basics.protectedBranches'].join(', ')}`
    }
    if (name === 'wait-guard') note += `, limit ${cfg.values['waitGuard.limitSeconds']}s`
    if (name === 'kill-guard') {
      const allow = cfg.values['killGuard.allowNames']
      const extra = cfg.values['killGuard.extraSharedNames']
      if (allow.length) note += `, allowed by name: ${allow.join(', ')}`
      if (extra.length) note += `, also protected: ${extra.join(', ')}`
    }
    if (name === 'orphan-reaper') {
      note += cfg.values['orphanReaper.onSessionEnd'] === false ? ', at session start only' : ', at session start and after each session ends'
      if (cfg.values['orphanReaper.extraNames'].length) note += `, also stops: ${cfg.values['orphanReaper.extraNames'].join(', ')}`
      if (cfg.values['orphanReaper.keepNames'].length) note += `, never stops: ${cfg.values['orphanReaper.keepNames'].join(', ')}`
    }
    if (name === 'port-guard' && cfg.values['portGuard.ignorePorts'].length) note += `, ignoring ports ${cfg.values['portGuard.ignorePorts'].join(', ')}`
    out.push(ok(name, note))
  }
  return out
}

function checkProcesses({ read = () => readProcesses(), files = () => readSessionFiles(), now = () => Date.now(), platform = process.platform } = {}) {
  const t0 = now()
  let snap
  try {
    snap = read()
  } catch (e) {
    return fail('processes', `the process reader failed on ${platform}: ${String(e.message).split('\n')[0]}. port-guard and status cannot see other sessions`)
  }
  const ms = now() - t0
  if (!snap) return warn('processes', `no process reader for ${platform}; port-guard, top and status see no sessions`)
  const sessions = findSessions(snap, files())
  const text = `${snap.procs.length} processes, ${snap.ports.length} listening ports, ${sessions.length} Claude session${sessions.length === 1 ? '' : 's'} in ${(ms / 1000).toFixed(1)}s`
  return ms > 8000 ? warn('processes', `${text}; slow, so port-guard may hit its 20s timeout on a busy machine`) : ok('processes', text)
}

function checkSessionsDir(dir = path.join(claudeDir(), 'sessions')) {
  return fs.existsSync(dir)
    ? ok('sessions', `${shortPath(dir)} (${readSessionFiles(dir).size} session files)`)
    : warn('sessions', `${shortPath(dir)} does not exist; checkout-guard cannot see other sessions and project names show as ?`)
}

function checkMemory(mem = readMemory({ withCommit: true })) {
  const lim = limits(mem.totalGb)
  const parts = [
    `${mem.freeGb.toFixed(1)} of ${mem.totalGb.toFixed(1)} GB free`,
    mem.commitPct != null ? `commit ${mem.commitPct}%` : null,
    `memory-guard blocks heavy commands below ${lim.minFreeGb} GB`,
    mem.totalGb < SMALL_MACHINE_GB ? 'bulkhead-slot runs one heavy job at a time' : `bulkhead-slot keeps ${lim.floorGb} GB free for a second job`,
    mem.commitPct != null ? `and waits while commit is above ${lim.maxCommitPct}%` : null,
  ].filter(Boolean)
  return mem.freeGb < lim.minFreeGb ? warn('memory', `${parts.join(', ')}; free RAM is below the minimum right now`) : ok('memory', parts.join(', '))
}

function checkSlots(dir = slotDir(stateDir())) {
  const held = readSlots(dir)
  const stale = held.filter(s => staleReason(s))
  if (stale.length) return warn('slots', `${held.length} held, ${stale.length} stale (${stale.map(s => `${s.label}: ${staleReason(s)}`).join('; ')}); the next bulkhead-slot run reclaims them`)
  return ok('slots', held.length ? `${held.length} held` : 'none held')
}

function checkLog(cfg, dir = stateDir()) {
  const key = 'log.enabled'
  if (cfg.values[key] === false) return ok('event log', `off (${why(cfg.sources[key])})`)
  const { bytes: size, files } = logSize(dir)
  if (!files) return ok('event log', `${shortPath(path.join(dir, 'events.jsonl'))}, empty so far`)
  const n = readEvents(dir).length
  return ok('event log', `${shortPath(path.join(dir, 'events.jsonl'))}, ${n} events, ${bytes(size)} (rotates at 1 MB)`)
}

// Runs kill-guard the way Claude Code does, in a clean state dir, to prove hooks start and block.
function checkHookRun(root = ROOT) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bulkhead-doctor-'))
  try {
    const t0 = Date.now()
    const r = spawnSync(process.execPath, [path.join(root, 'src', 'kill-guard.js')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pkill node' } }),
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, BULKHEAD_STATE_DIR: tmp, CLAUDE_PROJECT_DIR: tmp, BULKHEAD_DISABLE: '', BULKHEAD_NO_LOG: '1' },
    })
    const ms = Date.now() - t0
    if (r.status === 2 && /kill-guard/.test(r.stderr)) return ok('hook run', `kill-guard blocked a test command in ${ms} ms`)
    return fail('hook run', `kill-guard did not block a test command (exit ${r.status}${r.error ? `, ${r.error.message}` : ''})`)
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

function checkGit() {
  try {
    const v = execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return ok('git', v.replace(/^git version /, ''))
  } catch {
    return warn('git', 'git is not on PATH; checkout-guard and the git rules in basics pass everything')
  }
}

// One line per configured remote: reachable, bash, git and tar there, its folder writable.
// Nothing runs when no remote is configured, so doctor stays fast.
function checkRemotes(cfg, { env = process.env, probe = (r, ssh) => remote.probeSync(r, { ssh }) } = {}) {
  const all = Object.values(cfg.values.remotes || {})
  if (!all.length) return []
  const tools = remote.localTools(env)
  const out = []
  const missing = ['ssh', 'tar', 'git'].filter(t => !tools[t])
  if (missing.length) out.push(fail('remote tools', `${missing.join(', ')} not on PATH on this machine; bulkhead remote needs them`))
  else out.push(ok('remote tools', `ssh ${shortPath(tools.ssh.join(' '))}, tar ${shortPath(tools.tar)}`))
  if (!tools.ssh) return out
  for (const r of all) {
    const d = remote.describeProbe(r, probe(r, tools.ssh))
    out.push({ id: `remote ${r.name}`, status: d.status, summary: d.line.slice(r.name.length + 2) })
  }
  return out
}

function runAll({ remotes = true } = {}) {
  const cfg = config.load()
  return [
    checkNode(),
    checkPlugin(),
    checkStateDir(),
    ...checkConfig(cfg),
    ...checkGuards(cfg),
    checkHookRun(),
    checkProcesses(),
    checkSessionsDir(),
    checkMemory(),
    checkSlots(),
    checkLog(cfg),
    checkGit(),
    ...(remotes ? checkRemotes(cfg) : []),
  ]
}

function render(checks, { color = false } = {}) {
  const style = { OK: 'green', WARN: 'yellow', FAIL: 'red' }
  const width = Math.max(...checks.map(c => c.id.length))
  const lines = checks.map(c => `${paint(color, style[c.status], c.status.padEnd(4))}  ${c.id.padEnd(width)}  ${c.summary}`)
  const count = s => checks.filter(c => c.status === s).length
  lines.push('', `${count('OK')} OK, ${count('WARN')} WARN, ${count('FAIL')} FAIL`)
  return lines.join('\n')
}

function main(args, { stdout = process.stdout, env = process.env, checks = () => runAll({ remotes: !args.includes('--no-remote') }) } = {}) {
  const list = checks()
  if (args.includes('--json')) {
    stdout.write(JSON.stringify({ ok: !list.some(c => c.status === 'FAIL'), checks: list }, null, 2) + '\n')
  } else {
    stdout.write(render(list, { color: useColor(stdout, env) }) + '\n')
  }
  if (list.some(c => c.status === 'FAIL')) process.exitCode = 1
}

module.exports = {
  main, render, runAll, checkNode, checkPlugin, checkStateDir, checkConfig, checkGuards, checkProcesses, checkSessionsDir,
  checkMemory, checkSlots, checkLog, checkHookRun, checkGit, checkRemotes,
}
