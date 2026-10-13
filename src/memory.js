'use strict'
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const GB = 2 ** 30

function field(text, name) {
  const m = text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))
  return m ? Number(m[1]) : null
}

// Linux: MemAvailable already counts reclaimable cache. Commit is not used because
// the default overcommit mode makes Committed_AS routinely exceed CommitLimit.
function parseMeminfo(text) {
  const total = field(text, 'MemTotal')
  let avail = field(text, 'MemAvailable')
  if (avail === null) avail = (field(text, 'MemFree') || 0) + (field(text, 'Buffers') || 0) + (field(text, 'Cached') || 0)
  const swapTotal = field(text, 'SwapTotal')
  const swap = swapTotal ? { swapTotalGb: (swapTotal * 1024) / GB, swapUsedGb: ((swapTotal - (field(text, 'SwapFree') || 0)) * 1024) / GB } : {}
  return { totalGb: (total * 1024) / GB, freeGb: (avail * 1024) / GB, commitPct: null, ...swap }
}

// macOS: os.freemem() only counts pages that are completely unused, which is near zero
// on a healthy Mac. We approximate Activity Monitor instead:
// available = total - (app memory + wired + compressed), app memory = anonymous - purgeable.
// Older vm_stat output has no "Anonymous pages"; then free + inactive + speculative + purgeable.
function parseVmStat(text, totalBytes) {
  const page = Number((text.match(/page size of (\d+) bytes/) || [])[1]) || 4096
  const n = name => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))
    return m ? Number(m[1]) : 0
  }
  let freeBytes
  if (/^Anonymous pages:/m.test(text)) {
    const used = n('Anonymous pages') - n('Pages purgeable') + n('Pages wired down') + n('Pages occupied by compressor')
    freeBytes = totalBytes - used * page
  } else {
    freeBytes = (n('Pages free') + n('Pages inactive') + n('Pages speculative') + n('Pages purgeable')) * page
  }
  return { totalGb: totalBytes / GB, freeGb: Math.max(0, freeBytes) / GB, commitPct: null }
}

// Windows: commit charge can run out while RAM still looks "free", and the machine stalls when it does.
function parseWindowsCommit(text) {
  const [total, free] = String(text).trim().split(/\s+/).map(Number)
  if (!(total > 0) || !Number.isFinite(free)) return null
  return Math.round((100 * (total - free)) / total)
}

function windowsCommitPct(run) {
  try {
    return parseWindowsCommit(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$o = Get-CimInstance Win32_OperatingSystem; "$($o.TotalVirtualMemorySize) $($o.FreeVirtualMemory)"']))
  } catch {
    return null
  }
}

const defaultRun = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 8000, windowsHide: true })

// { totalGb, freeGb, commitPct } where commitPct is measured only on Windows and only on request.
function readMemory({ platform = process.platform, withCommit = false, run = defaultRun, readFile = fs.readFileSync } = {}) {
  if (process.env.BULKHEAD_TEST_MEMORY) return JSON.parse(process.env.BULKHEAD_TEST_MEMORY)
  if (platform === 'linux') {
    try { return parseMeminfo(readFile('/proc/meminfo', 'utf8')) } catch {}
  }
  if (platform === 'darwin') {
    try { return parseVmStat(run('vm_stat', []), os.totalmem()) } catch {}
  }
  const mem = { totalGb: os.totalmem() / GB, freeGb: os.freemem() / GB, commitPct: null }
  if (platform === 'win32' && withCommit) mem.commitPct = windowsCommitPct(run)
  return mem
}

module.exports = { readMemory, parseMeminfo, parseVmStat, parseWindowsCommit }
