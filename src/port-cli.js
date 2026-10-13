'use strict'
const net = require('net')
const { option } = require('./cli-util')

const USAGE = `usage: bulkhead port [--near PORT] [--json]

Prints the first port at or above PORT (default 3000) that nothing is listening on,
so a dev server can start there without taking another session's port:
  npm run dev -- --port $(bulkhead port --near 3000)`

// Ports browsers refuse to open (the fetch spec's "bad ports"), so a dev server there is useless.
const BROWSER_BLOCKED = new Set([1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080])

// One address at a time: on Windows a server on 127.0.0.1 does not stop a bind to 0.0.0.0 or ::1,
// so only a port all four accept is really free. Hosts without IPv6 report EADDRNOTAVAIL, which is fine.
const HOSTS = ['127.0.0.1', '0.0.0.0', '::1', '::']

function canBind(host, port) {
  return new Promise(resolve => {
    const s = net.createServer()
    s.unref()
    s.once('error', e => resolve(e.code !== 'EADDRINUSE' && e.code !== 'EACCES'))
    s.listen({ host, port, exclusive: true }, () => s.close(() => resolve(true)))
  })
}

async function isFree(port, bind = canBind) {
  for (const h of HOSTS) if (!(await bind(h, port))) return false
  return true
}

async function findFree(near = 3000, { bind = canBind, span = 1000 } = {}) {
  for (let p = Math.max(1024, near); p < Math.min(65536, near + span); p++) {
    if (BROWSER_BLOCKED.has(p)) continue
    if (await isFree(p, bind)) return p
  }
  return null
}

async function main(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (args.includes('--help') || args.includes('-h')) return stdout.write(USAGE + '\n')
  const nearArg = option(args, 'near')
  const near = nearArg === undefined ? 3000 : Number(nearArg)
  if (!Number.isInteger(near) || near < 1 || near > 65535) {
    stderr.write(`bulkhead port: --near needs a port number, got ${nearArg}\n`)
    process.exitCode = 1
    return
  }
  const port = await findFree(near)
  if (args.includes('--json')) stdout.write(JSON.stringify({ port }) + '\n')
  else if (port) stdout.write(`${port}\n`)
  if (!port) {
    if (!args.includes('--json')) stderr.write(`bulkhead port: no free port between ${near} and ${near + 999}\n`)
    process.exitCode = 1
  }
}

module.exports = { main, findFree, isFree, canBind, BROWSER_BLOCKED }
