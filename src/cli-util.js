'use strict'
const os = require('os')

// Small helpers shared by the bulkhead subcommands.

function useColor(stream = process.stdout, env = process.env) {
  return Boolean(stream && stream.isTTY) && !('NO_COLOR' in env) && env.TERM !== 'dumb'
}

const CODES = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, cyan: 36, gray: 90 }
function paint(on, style, s) {
  return on ? `\x1b[${CODES[style]}m${s}\x1b[0m` : String(s)
}

function shortPath(p, home = os.homedir()) {
  if (!p) return '?'
  const s = String(p)
  return home && s.toLowerCase().startsWith(home.toLowerCase()) ? '~' + s.slice(home.length).replace(/\\/g, '/') : s.replace(/\\/g, '/')
}

// --name value or --name=value. Returns undefined when absent, true for a bare flag at the end.
function option(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : true
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3)
  }
  return undefined
}

// Cut to `width` visible characters, ending in … when anything was dropped.
function fit(s, width) {
  s = String(s == null ? '' : s)
  if (width <= 0) return ''
  return s.length > width ? s.slice(0, Math.max(0, width - 1)) + '…' : s
}

// Columns padded to their widest cell; the last column is not padded.
function table(rows, gap = '  ') {
  const widths = []
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] || 0, String(c).length)))
  return rows.map(r => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join(gap).trimEnd())
}

function bytes(n) {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`
  if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

module.exports = { useColor, paint, shortPath, option, fit, table, bytes }
