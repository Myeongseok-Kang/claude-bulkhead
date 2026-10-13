'use strict'

const USAGE = `usage:
  bulkhead status [--json]              sessions, their ports and memory, slots, free RAM
  bulkhead top [--interval=SECONDS]     the same, live, full screen (q quits, r refreshes)
  bulkhead log [-n N] [--since 7d] [--guard NAME] [--summary] [--json]
                                        what the guards blocked
  bulkhead doctor [--json] [--no-remote] check the install, settings and this machine
  bulkhead config [--json]              effective settings and where each one came from
  bulkhead port [--near PORT] [--json]  a port no process is listening on
  bulkhead reap [--dry-run] [--json]    stop what exited sessions left running
  bulkhead slot run [--gb=N] [--wait=MINUTES] [--label=TEXT] -- <command...>
  bulkhead slot status [--gb=N]         same as bulkhead-slot
  bulkhead remote run [--remote=NAME] [--gb=N] [--tail=N] -- <command...>
                                        run a heavy command on another machine over ssh
  bulkhead remote status|list|add|remove|fetch   see bulkhead remote --help`

const COMMANDS = {
  status: './status',
  top: './top',
  log: './log-cli',
  doctor: './doctor',
  config: './config-cli',
  port: './port-cli',
  reap: './reap-cli',
  slot: './slot-cli',
  remote: './remote',
}

function main(argv) {
  const [cmd, ...rest] = argv
  if (COMMANDS[cmd]) return require(COMMANDS[cmd]).main(rest)
  const help = cmd === '--help' || cmd === '-h' || cmd === 'help'
  ;(help ? console.log : console.error)(USAGE)
  process.exit(help ? 0 : 1)
}

module.exports = { main, USAGE }
