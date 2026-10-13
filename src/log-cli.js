'use strict'
const { stateDir } = require('./hook')
const { readEvents, eventsFile } = require('./events')
const { useColor, paint, shortPath, option, fit, table } = require('./cli-util')

const USAGE = `usage: bulkhead log [-n N] [--since 7d|24h|30m] [--guard NAME] [--summary] [--json]

Lists what the guards blocked and what orphan-reaper stopped, newest last.
  -n N           how many events to list (default 20; ignored with --summary)
  --since SPAN   only events newer than SPAN: 30m, 24h, 7d, 2w, or a date such as 2026-10-01
  --guard NAME   only this guard, for example kill-guard
  --summary      counts per guard and rule, and per project
  --json         machine-readable output`

const UNITS = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }

// Milliseconds since the epoch, or NaN when the span cannot be read.
function parseSince(s, now = Date.now()) {
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(String(s).trim())
  if (m) return now - Number(m[1]) * UNITS[m[2].toLowerCase()]
  return /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? new Date(s).getTime() : NaN
}

// '7d' -> '7 days'; null for dates and anything else.
function humanSpan(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(String(s || '').trim())
  if (!m) return null
  const unit = { m: 'minute', h: 'hour', d: 'day', w: 'week' }[m[2].toLowerCase()]
  return `${m[1]} ${unit}${Number(m[1]) === 1 ? '' : 's'}`
}

function filter(events, { since, guard } = {}) {
  return events.filter(e => (since == null || Date.parse(e.time) >= since) && (!guard || e.guard === guard))
}

const pad2 = n => String(n).padStart(2, '0')
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')
function stamp(iso, now = Date.now()) {
  const d = new Date(iso)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return d.toDateString() === new Date(now).toDateString() ? hm : `${MONTHS[d.getMonth()]} ${pad2(d.getDate())} ${hm}`
}

function summarize(events) {
  const byRule = new Map()
  const byProject = new Map()
  const sessions = new Set()
  for (const e of events) {
    const k = `${e.guard}\u0000${e.rule || ''}`
    const r = byRule.get(k) || { guard: e.guard, rule: e.rule || '', count: 0, last: e.time }
    r.count++
    if (e.time > r.last) r.last = e.time
    byRule.set(k, r)
    if (e.project) byProject.set(e.project, (byProject.get(e.project) || 0) + 1)
    if (e.session) sessions.add(e.session)
  }
  const rules = [...byRule.values()].sort((a, b) => b.count - a.count || a.guard.localeCompare(b.guard) || a.rule.localeCompare(b.rule))
  const projects = [...byProject.entries()].map(([project, count]) => ({ project, count })).sort((a, b) => b.count - a.count)
  return {
    total: events.length,
    first: events.length ? events[0].time : null,
    last: events.length ? events[events.length - 1].time : null,
    sessions: sessions.size,
    rules,
    projects,
  }
}

function bar(n, max, width = 24) {
  if (!max) return ''
  return '█'.repeat(Math.max(1, Math.round((n / max) * width)))
}

function renderSummary(sum, { color = false, home, sinceLabel, now = Date.now() } = {}) {
  if (!sum.total) return `no blocks recorded${sinceLabel ? ` in the last ${sinceLabel}` : ''}`
  const out = []
  const span = sinceLabel ? `in the last ${sinceLabel}` : `since ${stamp(sum.first, now)}`
  out.push(paint(color, 'bold', `${sum.total} block${sum.total === 1 ? '' : 's'} ${span}`) +
    `, ${sum.projects.length} project${sum.projects.length === 1 ? '' : 's'}, ${sum.sessions} session${sum.sessions === 1 ? '' : 's'}`)
  out.push('')
  const max = sum.rules[0].count
  const rows = [['GUARD', 'RULE', 'COUNT', 'LAST', '']]
  for (const r of sum.rules) rows.push([r.guard, r.rule, String(r.count).padStart(5), stamp(r.last, now), bar(r.count, max)])
  const lines = table(rows)
  out.push(paint(color, 'bold', lines[0]))
  lines.slice(1).forEach(l => out.push(color ? l.replace(/█+$/, m => paint(true, 'cyan', m)) : l))
  if (sum.projects.length) {
    out.push('')
    const prow = [['PROJECT', 'COUNT']]
    for (const p of sum.projects.slice(0, 8)) prow.push([fit(shortPath(p.project, home), 48), String(p.count).padStart(5)])
    const pl = table(prow)
    out.push(paint(color, 'bold', pl[0]), ...pl.slice(1))
    if (sum.projects.length > 8) out.push(`and ${sum.projects.length - 8} more`)
  }
  return out.join('\n')
}

function renderList(events, { color = false, home, width = 120, now = Date.now() } = {}) {
  if (!events.length) return 'no blocks recorded'
  const rows = [['TIME', 'GUARD', 'RULE', 'SESSION', 'PROJECT', 'COMMAND']]
  for (const e of events) {
    rows.push([stamp(e.time, now), e.guard, e.rule || '', (e.session || '-').slice(0, 8), fit(shortPath(e.project, home), 28), e.command || ''])
  }
  const lines = table(rows)
  return lines.map((l, i) => {
    const cut = fit(l, Math.max(40, width))
    return i === 0 ? paint(color, 'bold', cut) : cut
  }).join('\n')
}

function main(args, { env = process.env, stdout = process.stdout, stderr = process.stderr, now = Date.now(), dir = stateDir() } = {}) {
  if (args.includes('--help') || args.includes('-h')) return stdout.write(USAGE + '\n')
  const sinceArg = option(args, 'since')
  let since = null
  if (sinceArg !== undefined && sinceArg !== '') {
    since = parseSince(sinceArg, now)
    if (!Number.isFinite(since)) {
      stderr.write(`bulkhead log: cannot read --since ${sinceArg}; use 30m, 24h, 7d, 2w or a date like 2026-10-01\n`)
      process.exitCode = 1
      return
    }
  }
  const guard = option(args, 'guard')
  const nArg = (() => {
    const i = args.indexOf('-n')
    return i >= 0 ? args[i + 1] : option(args, 'limit')
  })()
  const n = Number(nArg) > 0 ? Math.floor(Number(nArg)) : 20
  const events = filter(readEvents(dir), { since, guard: typeof guard === 'string' ? guard : null })
  const json = args.includes('--json')
  const color = useColor(stdout, env)
  if (args.includes('--summary')) {
    const sum = summarize(events)
    if (json) return stdout.write(JSON.stringify(sum, null, 2) + '\n')
    return stdout.write(renderSummary(sum, { color, sinceLabel: humanSpan(sinceArg), now }) + '\n')
  }
  const recent = events.slice(-n)
  if (json) return stdout.write(JSON.stringify(recent, null, 2) + '\n')
  if (!recent.length && !events.length && sinceArg === undefined && !guard) {
    return stdout.write(`no blocks recorded yet (${shortPath(eventsFile(dir))})\n`)
  }
  stdout.write(renderList(recent, { color, width: stdout.columns || 160, now }) + '\n')
}

module.exports = { main, parseSince, filter, summarize, renderSummary, renderList }
