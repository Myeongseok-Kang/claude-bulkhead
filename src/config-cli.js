'use strict'
const fs = require('fs')
const { load, KEYS } = require('./config')
const { useColor, paint, shortPath, table } = require('./cli-util')

function fileState(file, warnings) {
  if (!file) return 'none found'
  if (!fs.existsSync(file)) return 'not found'
  return warnings.some(w => w.startsWith(file) && /not valid JSON/.test(w)) ? 'INVALID, ignored' : 'loaded'
}

// The remotes map is long; the table shows the names and `bulkhead remote list` the rest.
const show = (v, key) => (v === null ? 'auto' : key === 'remotes' ? Object.keys(v).join(', ') || 'none' : JSON.stringify(v))

function render(cfg, { color = false, home } = {}) {
  const out = []
  out.push(paint(color, 'bold', 'Files (project wins over global, environment wins over both)'))
  out.push(`  global   ${shortPath(cfg.files.global, home)}  ${fileState(cfg.files.global, cfg.warnings)}`)
  out.push(`  project  ${cfg.files.project ? shortPath(cfg.files.project, home) : '<repo>/.claude/bulkhead.json'}  ${fileState(cfg.files.project, cfg.warnings)}`)
  out.push('')
  const rows = [['KEY', 'VALUE', 'FROM']]
  for (const key of Object.keys(KEYS)) {
    const src = cfg.sources[key]
    rows.push([key, show(cfg.values[key], key), src === 'default' || src.startsWith('env ') ? src : shortPath(src, home)])
  }
  const lines = table(rows)
  out.push(paint(color, 'bold', lines[0]))
  lines.slice(1).forEach((l, i) => {
    const key = rows[i + 1][0]
    out.push(cfg.sources[key] === 'default' ? paint(color, 'gray', l) : l)
  })
  if (cfg.warnings.length) {
    out.push('')
    for (const w of cfg.warnings) out.push(paint(color, 'yellow', `WARN ${w}`))
  }
  return out.join('\n')
}

function main(args, { env = process.env, stdout = process.stdout } = {}) {
  const cfg = load({ env })
  if (args.includes('--json')) {
    const settings = {}
    for (const key of Object.keys(KEYS)) settings[key] = { value: cfg.values[key], from: cfg.sources[key] }
    stdout.write(JSON.stringify({ files: cfg.files, settings, warnings: cfg.warnings }, null, 2) + '\n')
    return
  }
  stdout.write(render(cfg, { color: useColor(stdout, env) }) + '\n')
}

module.exports = { main, render }
