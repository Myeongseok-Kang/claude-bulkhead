'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { readMemory, parseMeminfo, parseVmStat, parseWindowsCommit } = require('../src/memory')

const MEMINFO = `MemTotal:       32768000 kB
MemFree:         1024000 kB
MemAvailable:    8388608 kB
Buffers:          204800 kB
Cached:          6000000 kB
CommitLimit:    20000000 kB
Committed_AS:   45000000 kB
`

const VM_STAT_SONOMA = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3000.
Pages active:                            300000.
Pages inactive:                          290000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                          20000.
"Translation faults":                 900000000.
Pages copy-on-write:                   20000000.
Pages zero filled:                    400000000.
Pages reactivated:                      1000000.
Pages purged:                           2000000.
File-backed pages:                       250000.
Anonymous pages:                         345000.
Pages stored in compressor:              200000.
Pages occupied by compressor:             60000.
`

const VM_STAT_OLD = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              100000.
Pages active:                            900000.
Pages inactive:                          400000.
Pages speculative:                        50000.
Pages wired down:                        300000.
Pages purgeable:                          10000.
`

test('linux uses MemAvailable and ignores overcommitted commit charge', () => {
  const m = parseMeminfo(MEMINFO)
  assert.strictEqual(m.freeGb, 8)
  assert.ok(Math.abs(m.totalGb - 31.25) < 0.01)
  assert.strictEqual(m.commitPct, null)
})

test('linux without MemAvailable falls back to free + buffers + cache', () => {
  const m = parseMeminfo('MemTotal: 1048576 kB\nMemFree: 262144 kB\nBuffers: 0 kB\nCached: 262144 kB\n')
  assert.strictEqual(m.freeGb, 0.5)
})

test('macOS estimates available memory like Activity Monitor', () => {
  const total = 16 * 2 ** 30
  const m = parseVmStat(VM_STAT_SONOMA, total)
  // used = (345000 - 20000 + 150000 + 60000) pages * 16 KiB = 8.16 GiB
  assert.ok(Math.abs(m.freeGb - (16 - (535000 * 16384) / 2 ** 30)) < 1e-9)
  assert.ok(m.freeGb > 7.8 && m.freeGb < 7.9)
})

test('macOS without anonymous page counts uses free + inactive + speculative + purgeable', () => {
  const m = parseVmStat(VM_STAT_OLD, 8 * 2 ** 30)
  assert.ok(Math.abs(m.freeGb - (560000 * 4096) / 2 ** 30) < 1e-9)
})

test('windows commit charge from Win32_OperatingSystem', () => {
  assert.strictEqual(parseWindowsCommit('67108864 16777216\r\n'), 75)
  assert.strictEqual(parseWindowsCommit(''), null)
})

test('readMemory picks the adapter by platform', () => {
  const linux = readMemory({ platform: 'linux', readFile: () => MEMINFO })
  assert.strictEqual(linux.freeGb, 8)
  const mac = readMemory({ platform: 'darwin', run: () => VM_STAT_SONOMA })
  assert.ok(mac.freeGb >= 0)
  const win = readMemory({ platform: 'win32', withCommit: true, run: () => '100 40' })
  assert.strictEqual(win.commitPct, 60)
  const noCommit = readMemory({ platform: 'win32', run: () => { throw new Error('not called') } })
  assert.strictEqual(noCommit.commitPct, null)
})
