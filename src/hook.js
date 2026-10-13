'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

// Fixed, not CLAUDE_PLUGIN_DATA: the bulkhead-slot CLI runs from the Bash tool, which
// does not receive that variable, and both sides must see the same slot files.
function stateDir() {
  return process.env.BULKHEAD_STATE_DIR || path.join(os.homedir(), '.claude', 'bulkhead')
}

// BULKHEAD_DISABLE first, then the config files. A broken config file never turns a guard off.
function enabled(name) {
  const off = (process.env.BULKHEAD_DISABLE || '').split(/[\s,]+/).filter(Boolean)
  if (off.includes(name) || off.includes('all')) return false
  try {
    return require('./config').isEnabled(name)
  } catch {
    return true
  }
}

// A value from the config files or its environment variable (see config.js).
function setting(key, fallback) {
  try {
    const v = require('./config').get(key)
    return v == null ? fallback : v
  } catch {
    return fallback
  }
}

function envNumber(name, fallback) {
  const n = Number(process.env[name])
  return process.env[name] && Number.isFinite(n) ? n : fallback
}

function log(name, line) {
  try {
    const dir = stateDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'guards.log'), `${new Date().toISOString()} ${name} ${line}\n`)
  } catch {}
}

// Records a block in guards.log and events.jsonl and returns the hook result that stops the call.
function blocked(name, rule, input, message, command = input && input.tool_input && input.tool_input.command) {
  log(name, `blocked ${rule}: ${oneLine(command || '')}`)
  recordEvent(name, rule, input, command)
  return { block: message }
}

function recordEvent(name, rule, input = {}, command = null, extra = {}) {
  if (setting('log.enabled', true) === false) return
  require('./events').record(stateDir(), {
    guard: name,
    rule,
    session: input.session_id || null,
    project: process.env.CLAUDE_PROJECT_DIR || input.cwd || null,
    command,
    ...extra,
  })
}

function oneLine(s, max = 300) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, max)
}

// Reads the hook payload from stdin and hands it to `handler`. The handler returns
// nothing to allow, { block: message } to stop the tool call (exit 2), or
// { output: object } to print JSON, or a promise of either. Any error lets the call through.
function runHook(name, handler) {
  if (!enabled(name)) return
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', d => (raw += d))
  process.stdin.on('end', () => {
    Promise.resolve().then(() => handler(JSON.parse(raw || '{}'))).then(result => {
      if (result && result.block) {
        process.stderr.write(result.block.endsWith('\n') ? result.block : result.block + '\n')
        process.exit(2)
      }
      if (result && result.output) process.stdout.write(JSON.stringify(result.output))
      process.exit(0)
    }, () => process.exit(0))
  })
}

module.exports = { runHook, enabled, setting, envNumber, log, oneLine, stateDir, blocked, recordEvent }
