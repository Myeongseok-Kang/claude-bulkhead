'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { setting } = require('./hook')

const MAX_SLOTS = 8
const SETTLE_MS = 150 * 1000
const MAX_AGE_MS = 12 * 3600 * 1000
const SMALL_MACHINE_GB = 24

// 3 GB free and a 5 GB floor are right for 32 GB; an 8 GB laptop would never get there.
// So the defaults are 15% and 25% of total RAM, capped at those values.
const round1 = n => Math.round(n * 10) / 10

function limits(totalGb = os.totalmem() / 2 ** 30) {
  return {
    minFreeGb: setting('memory.minFreeGb', Math.min(3, round1(totalGb * 0.15))),
    floorGb: setting('memory.slotFloorGb', Math.min(5, round1(totalGb * 0.25))),
    maxCommitPct: setting('memory.maxCommitPct', 75),
  }
}

// Returns '' when a job of `gb` may start, otherwise the reason it has to wait.
// Jobs younger than SETTLE_MS are counted at their full declared size because
// they have not reached their peak yet.
function admit({ held, mem, gb, now = Date.now(), limit = limits(mem.totalGb) }) {
  const free = mem.freeGb
  if (!held.length) {
    return free >= limit.minFreeGb ? '' : `free RAM ${free.toFixed(1)} GB is below ${limit.minFreeGb} GB`
  }
  if (mem.totalGb < SMALL_MACHINE_GB) return `this machine has ${Math.round(mem.totalGb)} GB; one heavy job at a time`
  if (held.length >= MAX_SLOTS) return `all ${MAX_SLOTS} slots are taken`
  const pending = held.filter(s => now - s.at < SETTLE_MS).reduce((sum, s) => sum + s.gb, 0)
  const left = free - pending - gb
  if (left < limit.floorGb) {
    return `free ${free.toFixed(1)} GB` + (pending ? ` - starting jobs ${pending} GB` : '') +
      ` - this job ${gb} GB = ${left.toFixed(1)} GB, below the ${limit.floorGb} GB floor`
  }
  if (mem.commitPct != null && mem.commitPct > limit.maxCommitPct) return `commit charge ${mem.commitPct}% is above ${limit.maxCommitPct}%`
  return ''
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function slotDir(stateDir) {
  return path.join(stateDir, 'slots')
}

function readSlots(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch {}
  const out = []
  for (const name of names.filter(n => /^slot-\d+\.json$/.test(n))) {
    const file = path.join(dir, name)
    try {
      out.push({ file, ...JSON.parse(fs.readFileSync(file, 'utf8')) })
    } catch {
      // half-written or corrupt: treat as held with no owner so reclaim() removes it
      out.push({ file, label: '?', gb: 0, at: 0, pid: 0 })
    }
  }
  return out
}

function staleReason(slot, now = Date.now(), isAlive = alive) {
  if (!slot.pid || !isAlive(slot.pid)) return `owner ${slot.pid || '?'} is gone`
  if (now - slot.at > MAX_AGE_MS) return 'older than 12 hours'
  return null
}

function reclaim(dir, onReclaim = () => {}) {
  for (const slot of readSlots(dir)) {
    const why = staleReason(slot)
    if (!why) continue
    try {
      fs.unlinkSync(slot.file)
      onReclaim(slot, why)
    } catch {}
  }
}

// mkdir is atomic on every platform we support, so it doubles as a cross-process lock.
function withLock(dir, fn, timeoutMs = 15000) {
  const lock = path.join(dir, '.lock')
  const until = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.rmdirSync(lock)
      } catch {}
      if (Date.now() > until) return null
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
  try {
    return fn()
  } finally {
    try { fs.rmdirSync(lock) } catch {}
  }
}

// Returns { file } on success or { reason } when the job has to wait.
function take(dir, { label, gb, pid }, measure, onReclaim) {
  fs.mkdirSync(dir, { recursive: true })
  const result = withLock(dir, () => {
    reclaim(dir, onReclaim)
    const held = readSlots(dir)
    const reason = admit({ held, mem: measure(held.length > 0), gb })
    if (reason) return { reason }
    const body = JSON.stringify({ label, gb, pid, at: Date.now() })
    for (let i = 1; i <= MAX_SLOTS; i++) {
      const file = path.join(dir, `slot-${i}.json`)
      try {
        fs.writeFileSync(file, body + '\n', { flag: 'wx' })
        return { file }
      } catch {}
    }
    return { reason: `all ${MAX_SLOTS} slots are taken` }
  })
  return result || { reason: 'another session is holding the slot lock' }
}

// Jobs waiting in bulkhead-slot run, one file per waiting process. Only for display: admission
// never reads them, and a file whose process is gone is skipped.
function queueDir(stateDir) {
  return path.join(stateDir, 'queue')
}

function enqueue(dir, entry) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${entry.pid}.json`)
    fs.writeFileSync(file, JSON.stringify(entry) + '\n')
    return file
  } catch {
    return null
  }
}

function readQueue(dir, isAlive = alive) {
  let names = []
  try { names = fs.readdirSync(dir) } catch {}
  const out = []
  for (const name of names.filter(n => /^\d+\.json$/.test(n))) {
    try {
      const q = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (q.pid && isAlive(q.pid)) out.push(q)
    } catch {}
  }
  return out.sort((a, b) => a.at - b.at)
}

function release(file) {
  try { fs.unlinkSync(file) } catch {}
}

module.exports = { admit, take, release, reclaim, readSlots, staleReason, slotDir, limits, queueDir, enqueue, readQueue }
