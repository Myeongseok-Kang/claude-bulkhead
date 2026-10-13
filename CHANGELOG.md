# Changelog

## 0.1.0 - 2026-10-13

First public release.

### Guards

- **kill-guard** blocks kills by program name that would hit other sessions' processes: `pkill`, `killall`, `taskkill /IM` and `/FI`, `Stop-Process -Name`, `Get-Process ... | Stop-Process`, `wmic ... delete`, name lookups fed to `kill` through `$(...)`, `xargs`, loops or variables, wildcards and several names at once. Kills scoped to a PID, a command line, a path or a script pass.
- **wait-guard** blocks foreground waits that can hold a session longer than 180 seconds: sleep loops, inline `python -c` or `node -e` sleeps, `timeout /t`, `ping -n`, `[Threading.Thread]::Sleep`, and following a log with `tail -f`, `docker logs -f`, `journalctl -f` or `Get-Content -Wait`. Sleeps in a background job pass.
- **memory-guard** blocks heavy commands (test suites, builds, browser automation, container builds) when free RAM is below 3 GB or 15% of RAM, and points to `bulkhead-slot` or, when one is configured, `bulkhead remote`.
- **port-guard** blocks starting a dev server on a port another live session is listening on and suggests a free one. It also blocks kills by port aimed at another session's server (`npx kill-port`, `fuser -k`, `lsof -t -i:N | xargs kill`, `Get-NetTCPConnection` with `Stop-Process`, `netstat` with `taskkill`).
- **checkout-guard** blocks `git checkout`, `switch`, `stash`, `reset --hard`, `clean -f`, `rebase`, `merge` and a dirty `pull` when another live session works in the same working tree, and suggests `git worktree add`.
- **basics** blocks `rm -rf` at roots, the home directory and folders above the repository, force-pushes to protected branches, and `git reset --hard` or `git clean -fd` that would lose uncommitted work. Each rule can be turned off.
- **orphan-reaper** stops what a finished session left running: dev servers, test runners and their workers (Vitest, Jest, Mocha, AVA, `node --test`, Playwright, pytest and pytest-xdist, `cargo test`, `go test`, `dotnet test`), watchers, builders and automation browsers. It runs within seconds of a session exiting (a detached waiter started by the `SessionEnd` hook) and again at session start. Only processes started from that session's Claude tool shells are touched; editors, terminals, shared build daemons and machine services are never stopped, nor anything under them. Windows, macOS and Linux.

All guards read commands through one shared parser for Bash, PowerShell and cmd that opens wrappers (`bash -c`, `powershell -Command`, `-EncodedCommand`, `cmd /c`, `eval`, `sudo`, `env`, `timeout`, `xargs` and more) up to three levels deep. Commit, tag, pull request and release text never triggers a guard. Commands sent to another machine or container are left to that machine.

### Commands

- `bulkhead status` and `bulkhead top`: sessions with their project, memory, child processes and ports, slot jobs and the queue, free RAM, and the latest blocks. `top` is a live full-screen view.
- `bulkhead-slot run --gb=N -- <command>` (also `bulkhead slot`): queues heavy commands against a RAM budget shared by every session on the machine.
- `bulkhead remote` (optional): runs a heavy command on another machine over SSH. It sends the commit as an incremental git bundle plus uncommitted changes, runs it in one of up to 8 copies of the repository with its own port in `BULKHEAD_PORT`, returns the exit code, and stops everything the command started when it ends or the connection drops. `--tail=N` keeps the full output in a file and prints only the end. Also `fetch`, `status`, `list`, `add` and `remove`. The remote needs only an SSH server, bash, git and tar. See `docs/remote.md`.
- `bulkhead reap [--dry-run]`: runs orphan-reaper by hand; the dry run lists what it would stop and why.
- `bulkhead log`: what the guards blocked and what orphan-reaper stopped, with `--since`, `--guard`, `--summary` and `--json`.
- `bulkhead doctor`: checks the install, the settings, each guard, the process reader, RAM limits, slots, the event log, git and configured remotes.
- `bulkhead config`: every setting, its effective value and where it came from.
- `bulkhead port [--near N]`: a port nothing listens on.
- `bulkhead-statusline`: live sessions, held slots and free RAM for the Claude Code status line.
- Slash commands `/bulkhead:status`, `/bulkhead:log`, `/bulkhead:doctor`, `/bulkhead:remote` and `/bulkhead:reap`, and a `bulkhead` skill that tells Claude how to work on a machine shared with other sessions.

### Configuration

- `~/.claude/bulkhead/config.json` and a per-project `.claude/bulkhead.json`, merged in that order, with environment variables winning. Every guard can be turned off, and the common false positives have their own keys. A broken file is ignored and reported once at session start. Remotes can be set in the global file only. See `config.example.json` and `docs/configuration.md`.
- Every block and every stopped process is appended to `events.jsonl` in the state directory; `BULKHEAD_NO_LOG=1` turns it off.

### Quality

- More than 2,400 tests on Linux, macOS and Windows with Node 18, 22 and 24, including a corpus of more than 900 real command lines run through the actual hooks, a fuzz test that checks every guard stays linear on 1 MB inputs, and an end-to-end `bulkhead remote` run against a real SSH server.
- No dependencies. Each guard adds about 40 to 50 ms to a tool call.
