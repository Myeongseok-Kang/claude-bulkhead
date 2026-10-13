'use strict'
const fs = require('fs')
const path = require('path')
const { stateDir } = require('./hook')
const { readMemory } = require('./memory')
const { readSessionFiles } = require('./sessions')
const { readSlots, slotDir, staleReason } = require('./slots')

const CACHE_MS = 5000

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// Only cheap reads: session files, slot files and free RAM. No process scan, so it stays
// well under the 300 ms the status line debounce allows.
function line({ files = readSessionFiles(), slots = readSlots(slotDir(stateDir())), mem = readMemory(), isAlive = alive } = {}) {
  const sessions = [...files.keys()].filter(isAlive).length
  const heavy = slots.filter(s => !staleReason(s, Date.now(), isAlive)).length
  return `${sessions} session${sessions === 1 ? '' : 's'}  ${heavy} heavy  ${mem.freeGb.toFixed(1)} GB free`
}

function cached(file, now = Date.now(), compute = line) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (now - c.at < CACHE_MS && now >= c.at) return c.text
  } catch {}
  const text = compute()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ at: now, text }))
  } catch {}
  return text
}

function main() {
  let text = ''
  try {
    text = cached(path.join(stateDir(), 'statusline.json'))
  } catch {}
  process.stdout.write(text + '\n')
}

module.exports = { line, cached, main }
