'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

// Every temporary directory a test file makes is removed when that test process exits.
const made = []
process.on('exit', () => {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulkhead-test-'))
  made.push(dir)
  return dir
}

// Runs a hook script the way Claude Code does: JSON on stdin, verdict in the exit code.
function runScript(name, input, env = {}) {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input)
  const stateDir = tempDir()
  try {
    return spawnSync(process.execPath, [path.join(__dirname, '..', 'src', `${name}.js`)], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, BULKHEAD_DISABLE: '', BULKHEAD_STATE_DIR: stateDir, ...env },
    })
  } finally {
    // the state directory is never read back, so a run leaves nothing in the temp folder
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

module.exports = { runScript, tempDir }
