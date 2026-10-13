'use strict'
const { useColor, paint, fit } = require('./cli-util')

const USAGE = `usage: bulkhead reap [--dry-run] [--json]

Stops what Claude Code sessions that have exited left running: dev servers and anything else
listening, test runners and their workers, watchers, builders and automation browsers started
from a Claude tool shell. orphan-reaper does the same in the background when a session starts
and right after one ends; this runs it now.
  --dry-run   list what would be stopped and why, stop nothing
  --json      machine-readable output`

function main(args, { stdout = process.stdout, stderr = process.stderr, platform = process.platform, run } = {}) {
  if (args.includes('--help') || args.includes('-h')) return stdout.write(USAGE + '\n')
  const unknown = args.filter(a => !['--dry-run', '--json'].includes(a))
  if (unknown.length) {
    stderr.write(`bulkhead reap: unknown option ${unknown[0]}\n${USAGE}\n`)
    process.exitCode = 1
    return
  }
  const reaper = require('./orphan-reaper')
  const dryRun = args.includes('--dry-run')
  const json = args.includes('--json')
  if (!reaper.SUPPORTED.includes(platform)) {
    if (json) stdout.write(JSON.stringify({ supported: false, platform, dryRun, orphans: [] }) + '\n')
    else stderr.write(`bulkhead reap: ${platform} is not supported\n`)
    process.exitCode = 1
    return
  }
  let done
  try {
    done = (run || reaper.run)({ platform, dryRun, trigger: 'manual' })
  } catch (e) {
    stderr.write(`bulkhead reap: could not read the process table: ${String(e.message).split('\n')[0]}\n`)
    process.exitCode = 1
    return
  }
  if (json) {
    const orphans = done.map(({ orphan: o, pids }) => ({ pid: o.pid, name: o.name, rule: o.rule, what: o.what, why: o.why, owner: o.owner, top: o.top, pids, command: o.cmd }))
    stdout.write(JSON.stringify({ supported: true, dryRun, orphans }, null, 2) + '\n')
    return
  }
  if (!done.length) return stdout.write('nothing to stop: no process left by an exited Claude session\n')
  const color = useColor(stdout)
  const width = Math.max(60, (stdout.columns || 120) - 4)
  const lines = []
  for (const { orphan: o, pids } of done) {
    lines.push(`${paint(color, 'bold', dryRun ? 'would stop' : 'stopped')} ${o.pid}  ${paint(color, 'yellow', o.rule)}  ${fit(o.cmd || o.name, width - 30)}`)
    lines.push(paint(color, 'dim', `  ${o.what}; ${o.why}; ${pids.length} process${pids.length === 1 ? '' : 'es'} from ${o.top}`))
  }
  const n = done.length
  lines.push(dryRun ? `${n} tree${n === 1 ? '' : 's'} would be stopped. Run \`bulkhead reap\` to stop ${n === 1 ? 'it' : 'them'}.` : `${n} tree${n === 1 ? '' : 's'} stopped; see \`bulkhead log --guard orphan-reaper\`.`)
  stdout.write(lines.join('\n') + '\n')
}

module.exports = { main, USAGE }
