'use strict'
// A stand-in for ssh in tests, set through BULKHEAD_SSH. It skips the options, then runs the
// remote command through this machine's shell with stdin, stdout and stderr passed straight
// through, as sshd does: cmd on Windows, so a quoted Git Bash path is parsed the way a Windows
// server parses it, and /bin/sh elsewhere. A host starting with "unreachable" fails like a
// refused connection, with exit 255. With FAKE_SSH_COUNT=<file> and FAKE_SSH_DROP=<n>, the n-th
// connection reads a little of its input and then drops, as a network failure would.
const fs = require('fs')
const { spawn } = require('child_process')

const args = process.argv.slice(2)
// `node --test` runs every file under test/, this one too, without arguments
if (!args.length) process.exit(0)
const VALUED = new Set(['-o', '-i', '-p', '-l', '-F', '-J', '-E', '-b', '-c', '-m'])
let i = 0
while (i < args.length && args[i].startsWith('-')) i += VALUED.has(args[i]) ? 2 : 1
const host = args[i]
const command = args.slice(i + 1).join(' ')
if (!host || host.startsWith('unreachable')) {
  process.stderr.write(`ssh: connect to host ${host} port 22: Connection refused\r\n`)
  process.exit(255)
}
if (process.env.FAKE_SSH_COUNT) {
  let n = 0
  try { n = Number(fs.readFileSync(process.env.FAKE_SSH_COUNT, 'utf8')) || 0 } catch {}
  fs.writeFileSync(process.env.FAKE_SSH_COUNT, String(++n))
  if (n === Number(process.env.FAKE_SSH_DROP)) {
    process.stdin.once('data', () => {
      process.stderr.write('client_loop: send disconnect: Connection reset\r\n')
      process.exit(255)
    })
    return
  }
}
const child = spawn(command, { shell: true, stdio: 'inherit', windowsHide: true })
child.on('error', () => process.exit(255))
child.on('exit', code => process.exit(code == null ? 255 : code))
