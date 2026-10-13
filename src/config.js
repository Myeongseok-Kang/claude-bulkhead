'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathKey } = require('./paths')

// Settings come from three places, later ones winning:
//   1. defaults below
//   2. <state dir>/config.json                      (global, usually ~/.claude/bulkhead/config.json)
//   3. <project>/.claude/bulkhead.json              (project, merged over global)
//   4. environment variables                        (always win)
// A file that is not valid JSON is ignored as a whole, so the guards keep their defaults.

const GUARDS = {
  'kill-guard': 'killGuard',
  'wait-guard': 'waitGuard',
  'memory-guard': 'memoryGuard',
  'port-guard': 'portGuard',
  'checkout-guard': 'checkoutGuard',
  basics: 'basics',
  'orphan-reaper': 'orphanReaper',
}
// basics rules that can be turned off one at a time
const RULES = { 'rm-root': 'basics.rmRoot', 'force-push-main': 'basics.forcePushMain', 'discard-changes': 'basics.discardChanges' }

const bool = (def, doc) => ({ type: 'boolean', default: def, doc })
const on = g => bool(true, `Turn ${g} on or off.`)
// In display order: each section's keys together.
const KEYS = {
  'killGuard.enabled': on('kill-guard'),
  'killGuard.allowNames': { type: 'string[]', default: [], doc: 'Program names to take off the shared list, so killing them by name passes.' },
  'killGuard.extraSharedNames': { type: 'string[]', default: [], doc: 'More program names that must not be killed by name.' },
  'waitGuard.enabled': on('wait-guard'),
  'waitGuard.limitSeconds': { type: 'number', default: 180, env: 'BULKHEAD_WAIT_MAX_SEC', doc: 'Longest foreground wait allowed, in seconds.' },
  'memoryGuard.enabled': on('memory-guard'),
  'memory.minFreeGb': { type: 'number', default: null, env: 'BULKHEAD_MIN_FREE_GB', doc: 'Free RAM below which memory-guard blocks heavy commands. Default: 3, or 15% of RAM if less.' },
  'memory.slotFloorGb': { type: 'number', default: null, env: 'BULKHEAD_SLOT_FLOOR_GB', doc: 'RAM bulkhead-slot keeps free when it starts a second job. Default: 5, or 25% of RAM if less.' },
  'memory.maxCommitPct': { type: 'number', default: 75, env: 'BULKHEAD_MAX_COMMIT_PCT', doc: 'Windows commit charge above which bulkhead-slot holds a second job.' },
  'portGuard.enabled': on('port-guard'),
  'portGuard.ignorePorts': { type: 'number[]', default: [], doc: 'Ports port-guard never checks, for starting servers or for kills by port.' },
  'checkoutGuard.enabled': on('checkout-guard'),
  'basics.enabled': on('basics'),
  'basics.protectedBranches': { type: 'string[]', default: ['main', 'master'], doc: 'Branches force-push-main protects.' },
  'basics.rmRoot': bool(true, 'Block rm -rf at roots, the home directory and folders above the repository.'),
  'basics.forcePushMain': bool(true, 'Block force-pushes to the protected branches.'),
  'basics.discardChanges': bool(true, 'Block git reset --hard and git clean -fd that would lose work.'),
  'orphanReaper.enabled': on('orphan-reaper'),
  'orphanReaper.onSessionEnd': bool(true, 'Also reap right after a session exits, not only when the next session starts.'),
  'orphanReaper.extraNames': { type: 'string[]', default: [], doc: 'More program names orphan-reaper stops once the session that started them has exited.' },
  'orphanReaper.keepNames': { type: 'string[]', default: [], doc: 'Program names orphan-reaper never stops, nor anything they started.' },
  'log.enabled': bool(true, 'Write blocks to events.jsonl. BULKHEAD_NO_LOG=1 turns it off.'),
  // Global file only (see src/remotes.js for why).
  'remote.default': { type: 'string', default: null, globalOnly: true, doc: 'The remote bulkhead remote uses when several are configured and --remote is not given.' },
  remotes: { type: 'remotes', default: {}, globalOnly: true, doc: 'Machines bulkhead remote can run jobs on: { name: { host, shell, dir, copies, maxJobs, minFreeGb, sshOptions } }.' },
}

function stateDir(env = process.env) {
  return env.BULKHEAD_STATE_DIR || path.join(os.homedir(), '.claude', 'bulkhead')
}

function globalFile(env = process.env) {
  return path.join(stateDir(env), 'config.json')
}

// <dir>/.claude/bulkhead.json in the project or the nearest folder above it, stopping at the
// repository root (a .git entry) or the home directory.
function projectFile(start, { exists = fs.existsSync, home = os.homedir() } = {}) {
  if (!start) return null
  let dir = path.resolve(start)
  // the cwd and the home directory may be spelled differently (a link, C:\Users\RUNNER~1); any case, as before
  const stop = pathKey(home, 'win32')
  for (let i = 0; i < 40; i++) {
    const f = path.join(dir, '.claude', 'bulkhead.json')
    if (exists(f)) return f
    if (exists(path.join(dir, '.git')) || pathKey(dir, 'win32') === stop) return null
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

function typeOk(type, v) {
  if (type === 'boolean') return typeof v === 'boolean'
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (type === 'string') return typeof v === 'string'
  if (type === 'string[]') return Array.isArray(v) && v.every(x => typeof x === 'string')
  if (type === 'number[]') return Array.isArray(v) && v.every(x => Number.isInteger(x) && x > 0 && x < 65536)
  return false
}

// Flat { 'section.key': value } from one parsed file, with a warning for every key we do not know
// or whose value has the wrong type. Bad keys are dropped, good ones kept. `remotes` is a map
// of its own, checked entry by entry, and kept whole under the key 'remotes'.
function flatten(obj, file, warnings, scope = 'global') {
  const out = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    warnings.push(`${file}: expected a JSON object`)
    return out
  }
  for (const [section, body] of Object.entries(obj)) {
    if (section === '$schema' || section === '//') continue
    if (section === 'remotes') {
      if (scope !== 'global') {
        warnings.push(`${file}: "remotes" can only be set in the global config file; ignored here`)
        continue
      }
      const { remotes, problems } = require('./remotes').normalizeAll(body)
      for (const p of problems) warnings.push(`${file}: ${p}`)
      out.remotes = remotes
      continue
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      warnings.push(`${file}: "${section}" should be an object`)
      continue
    }
    for (const [k, v] of Object.entries(body)) {
      const key = `${section}.${k}`
      const spec = KEYS[key]
      if (!spec) warnings.push(`${file}: unknown key "${key}"`)
      else if (spec.globalOnly && scope !== 'global') warnings.push(`${file}: "${key}" can only be set in the global config file; ignored here`)
      else if (!typeOk(spec.type, v)) warnings.push(`${file}: "${key}" should be ${spec.type}`)
      else out[key] = v
    }
  }
  return out
}

function readFile(file, warnings, read = f => fs.readFileSync(f, 'utf8'), scope = 'global') {
  let text
  try { text = read(file) } catch { return null }
  try {
    return flatten(JSON.parse(text.replace(/^\uFEFF/, '')), file, warnings, scope)
  } catch (e) {
    warnings.push(`${file} is not valid JSON (${e.message}); it is ignored until fixed`)
    return {}
  }
}

function envValue(spec, env) {
  const raw = env[spec.env]
  if (raw === undefined || raw === '') return undefined
  if (spec.type === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  return raw
}

// Defaults with both files merged over them. Read once per process.
function fileLayer({ env = process.env, cwd = env.CLAUDE_PROJECT_DIR || process.cwd(), read } = {}) {
  const warnings = []
  const values = {}
  const sources = {}
  for (const [k, spec] of Object.entries(KEYS)) {
    values[k] = spec.default
    sources[k] = 'default'
  }
  const files = { global: globalFile(env), project: projectFile(cwd) }
  for (const [scope, file] of [['global', files.global], ['project', files.project]]) {
    if (!file) continue
    const got = readFile(file, warnings, read, scope)
    if (!got) continue
    for (const [k, v] of Object.entries(got)) {
      values[k] = v
      sources[k] = file
    }
  }
  return { values, sources, files, warnings }
}

// { values, sources, files, warnings }. sources[key] is 'default', a file path or 'env NAME'.
function load(opts = {}) {
  return withEnv(fileLayer(opts), opts.env || process.env)
}

// Environment variables win over both files. Applied on every call, since tests and the
// slot CLI change them while running.
function withEnv(layer, env) {
  const values = { ...layer.values }
  const sources = { ...layer.sources }
  for (const [k, spec] of Object.entries(KEYS)) {
    const v = spec.env && envValue(spec, env)
    if (v !== undefined) {
      values[k] = v
      sources[k] = `env ${spec.env}`
    }
  }
  if (/^(?:1|true|yes)$/i.test(String(env.BULKHEAD_NO_LOG || '').trim())) {
    values['log.enabled'] = false
    sources['log.enabled'] = 'env BULKHEAD_NO_LOG'
  }
  const off = (env.BULKHEAD_DISABLE || '').split(/[\s,]+/).filter(Boolean)
  for (const name of off) {
    const key = GUARDS[name] ? `${GUARDS[name]}.enabled` : RULES[name]
    const keys = name === 'all' ? Object.values(GUARDS).map(s => `${s}.enabled`) : key ? [key] : []
    for (const k of keys) {
      values[k] = false
      sources[k] = 'env BULKHEAD_DISABLE'
    }
  }
  return { values, sources, files: layer.files, warnings: layer.warnings }
}

let cached = null
function current() {
  if (!cached) cached = fileLayer()
  return withEnv(cached, process.env)
}
function reset() {
  cached = null
}

function get(key, cfg = current()) {
  return cfg.values[key]
}

// Whether a guard or a basics rule is on.
function isEnabled(name, cfg = current()) {
  const key = GUARDS[name] ? `${GUARDS[name]}.enabled` : RULES[name]
  return key ? cfg.values[key] !== false : true
}

module.exports = { load, current, reset, get, isEnabled, projectFile, globalFile, KEYS, GUARDS, RULES, flatten }
