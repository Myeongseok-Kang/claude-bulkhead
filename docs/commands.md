# Commands

`bulkhead` and `bulkhead-slot` are in the plugin's `bin/` directory, which Claude Code puts on the Bash tool's `PATH` while the plugin is enabled. Outside Claude Code, call them by path, for example `node ~/.claude/plugins/cache/bulkhead/bulkhead/<version>/bin/bulkhead status`.

Every command that prints a table also takes `--json`. Colors are used only when the output is a terminal and `NO_COLOR` is not set.

| Command | What it does |
|---|---|
| [`bulkhead status`](#bulkhead-status) | Sessions, their memory, ports, heavy jobs and free RAM, once |
| [`bulkhead top`](#bulkhead-top) | The same, live, full screen |
| [`bulkhead log`](#bulkhead-log) | What the guards blocked and what orphan-reaper stopped |
| [`bulkhead doctor`](#bulkhead-doctor) | Checks the install, the settings and this machine |
| [`bulkhead config`](#bulkhead-config) | Effective settings and where each one came from |
| [`bulkhead port`](#bulkhead-port) | A port nothing is listening on |
| [`bulkhead reap`](#bulkhead-reap) | Stops what sessions that have exited left running, or lists it with `--dry-run` |
| [`bulkhead-slot`](#bulkhead-slot) | Queues heavy commands against a shared RAM budget |
| [`bulkhead remote`](#bulkhead-remote) | Runs a heavy command on another machine over SSH (optional) |

The plugin also adds slash commands that run these and summarize the result: `/bulkhead:status`, `/bulkhead:log [24h|7d|...]`, `/bulkhead:doctor`, `/bulkhead:reap` (a dry run) and `/bulkhead:remote <command>`.

## bulkhead status

```
bulkhead status [--json]
```

```
SESSION  STARTED       RSS     PROJECT
18672    Oct 12 17:49  1.4 GB  ~/src/acme-web
  :3000  node.exe  pid 24632
21888    Oct 12 17:52  353 MB  ~/src/acme-web-auth
26448    03:43         625 MB  ~/src/acme-web-checkout
  :3001  node.exe  pid 31020

SLOT    GB  PID    AGE    COMMAND
slot-1  4   30112  6 min  npx playwright test

WAITING  GB  PID    FOR    COMMAND
#1       3   30200  2 min  npm run build

9.9 GB free of 31.8 GB, commit 68%
```

A session is a running `claude` CLI process. RSS is the sum over its process tree. The project comes from the session file Claude Code keeps in `~/.claude/sessions`, or from `/proc/<pid>/cwd` on Linux. The `WAITING` table appears only when `bulkhead-slot run` jobs are queued.

`--json` adds per-session `children` (processes in the tree besides the session itself), raw byte counts, ISO times, and the queue with each job's reason for waiting.

## bulkhead top

```
bulkhead top [--interval=SECONDS] [--once]
```

A full-screen view that refreshes every 2 seconds on Linux and macOS and every 4 seconds on Windows, where one process scan takes 1 to 2 seconds. The scan runs in a worker thread, so the screen and the keys never wait for it; the header shows `scanning` while one is running and the last scan's duration otherwise.

```
bulkhead top  14:30:05                                         scan 1.4s  every 4s  q quit  r refresh
RAM ████████████████░░░░░░░░░░░░░░  9.9 GB free of 31.8 GB  commit 68%

SESSIONS 3
PID      STARTED       PROJECT                         RSS              PROCS  PORTS
18672    Oct 12 17:49  ~/src/acme-web               1.4 GB  ██████████     12  :3000 :24678
21888    Oct 12 17:52  ~/src/acme-web-auth          353 MB  ███░░░░░░░      3  -
26448    03:43         ~/src/acme-web-checkout      625 MB  ████░░░░░░      5  :3001

HEAVY JOBS  1 running, 1 waiting
slot-1  4 GB   30112   6 min   npx playwright test
wait #1 3 GB   30200   2 min   npm run build  (this machine has 16 GB; one heavy job at a time)

RECENT BLOCKS
14:29  kill-guard     taskkill-im    ~/src/acme-web-auth      taskkill /F /IM node.exe
14:12  wait-guard     poll-loop      ~/src/acme-web-checkout  until [ -f out/DONE ]; do sleep 30; done
```

- The RAM bar shows used memory. It is green above the slot floor, yellow below it, and red below the memory-guard minimum, when a line under it says heavy commands are being blocked. Linux adds swap, Windows adds commit charge.
- RSS bars are relative to the largest session. PROCS counts the processes in the session's tree besides the session itself.
- Keys: `q`, `Esc` or `Ctrl-C` quit, `r` refreshes at once.
- The terminal is restored on every exit path: the view runs in the alternate screen buffer, and quitting, `Ctrl-C`, `SIGTERM` and `SIGHUP` all leave it and show the cursor again.
- On a narrow terminal, columns are dropped in this order: the RSS bar, the start time, the ports, the process count. Then the project column shrinks and long values end in `…`. Lines never wrap. When there are more sessions than rows, the list ends in `... N more`.
- When the output is not a terminal (a pipe, a file, the Bash tool), or with `--once`, it prints one snapshot without colors and exits.

## bulkhead log

```
bulkhead log [-n N] [--since SPAN] [--guard NAME] [--summary] [--json]
```

Every block by kill-guard, wait-guard, memory-guard, port-guard, checkout-guard and basics, and every process orphan-reaper stops, is appended as one JSON line to `events.jsonl` in the state directory (`~/.claude/bulkhead` unless `BULKHEAD_STATE_DIR` is set). See [The event log](#the-event-log) below.

| Option | Meaning |
|---|---|
| `-n N`, `--limit=N` | How many events to list, newest last. Default 20 |
| `--since SPAN` | Only newer events. `30m`, `24h`, `7d`, `2w`, or a date such as `2026-10-01`. Empty means all time |
| `--guard NAME` | Only one guard, such as `kill-guard` |
| `--summary` | Counts per guard and rule, and per project |
| `--json` | The events, or the summary, as JSON |

```
$ bulkhead log -n 5
TIME   GUARD         RULE             SESSION  PROJECT                  COMMAND
06:40  kill-guard    pkill            s-c3     ~/src/acme-web-checkout  pkill -f python
06:40  memory-guard  slot-files       s-b2     ~/src/acme-web-auth      echo {} > ~/.claude/bulkhead/slots/slot-2.json
06:40  basics        force-push-main  s-c3     ~/src/acme-web-checkout  git push --force origin main
06:40  basics        rm-root          s-b2     ~/src/acme-web-auth      rm -rf ~/
06:40  wait-guard    long-sleep       s-a4     ~/src/acme-web           sleep 900
```

```
$ bulkhead log --summary --since 7d
10 blocks in the last 7 days, 3 projects, 4 sessions

GUARD         RULE             COUNT  LAST
wait-guard    poll-loop            3  06:40  ████████████████████████
wait-guard    long-sleep           2  06:40  ████████████████
basics        force-push-main      1  06:40  ████████
basics        rm-root              1  06:40  ████████
kill-guard    pkill                1  06:40  ████████
kill-guard    taskkill-im          1  06:40  ████████
memory-guard  slot-files           1  06:40  ████████

PROJECT                  COUNT
~/src/acme-web               4
~/src/acme-web-auth          3
~/src/acme-web-checkout      3
```

Times are today's `HH:MM`, or `Mon DD HH:MM` for older days.

### The event log

Each line has these fields:

| Field | Meaning |
|---|---|
| `time` | ISO 8601, UTC |
| `guard` | `kill-guard`, `wait-guard`, `memory-guard`, `port-guard`, `checkout-guard`, `basics` or `orphan-reaper` |
| `rule` | What matched, see below |
| `session` | Claude Code session ID. For orphan-reaper, the exited session after `SessionEnd`, else null |
| `project` | `CLAUDE_PROJECT_DIR`, else the tool call's working directory. For orphan-reaper, the exited session's project: from the `SessionEnd` hook, or from its session file when that is still there |
| `command` | The command, on one line, cut to 200 characters. For orphan-reaper, the stopped process's command line |
| `pid` | orphan-reaper only: the process that matched the rule; its whole tree was stopped |
| `trigger` | orphan-reaper only: `session-end`, `startup` or `manual` (`bulkhead reap`) |

Rules per guard:

| Guard | Rules |
|---|---|
| kill-guard | `taskkill-im`, `taskkill-filter`, `stop-process-name`, `get-process-pipe`, `pkill`, `pgrep-kill`, `ps-grep-kill`, `wmic-name`, `win32-process-name` |
| wait-guard | `poll-loop`, `long-sleep` |
| memory-guard | `low-memory`, `slot-files` |
| port-guard | `port-in-use` (starting a server on another session's port), `kill-by-port` |
| checkout-guard | `git-<subcommand>`, such as `git-checkout`, `git-stash`, `git-pull` |
| basics | `rm-root`, `force-push-main`, `discard-changes` |
| orphan-reaper | `test-runner`, `watcher`, `builder`, `headless-browser`, `dev-server`, `extra-name`; see [the rules table](guards/orphan-reaper.md#what-it-stops) |

The file is rotated at 1 MB: the current file becomes `events.jsonl.1` (replacing the previous one) and a new file starts, so the log never takes more than about 2 MB. `bulkhead log` reads both files.

Writing an event is one `stat` and one append, only on the block path, and never throws: an unwritable state directory loses the event, not the block. `BULKHEAD_NO_LOG=1` or `"log": { "enabled": false }` turns it off. `guards.log` in the same directory keeps a one-line text record of each block as before.

## bulkhead doctor

```
bulkhead doctor [--json] [--no-remote]
```

Runs every check and prints one line each, `OK`, `WARN` or `FAIL`. The exit code is 1 when any check fails. When remotes are configured, it also connects to each one; `--no-remote` skips that.

| Check | FAIL or WARN when |
|---|---|
| `node` | FAIL below Node 18 |
| `plugin` | FAIL when `hooks/hooks.json` cannot be read or names a script that does not exist |
| `state dir` | FAIL when the state directory cannot be written; slots and the event log need it |
| `config` | WARN for each config problem: invalid JSON, an unknown key, a value of the wrong type |
| one line per guard | Says `on` or `off` and why (`env BULKHEAD_DISABLE`, or the config file that turned it off), plus its main setting. WARN when orphan-reaper is on for a platform it does not support |
| `hook run` | FAIL when kill-guard, started the way Claude Code starts it, does not block a test command. Shows how long it took |
| `processes` | FAIL when the process reader fails (no PowerShell, no `/proc`, no `ps`). WARN above 8 seconds. Shows the process, port and session counts and the time taken |
| `sessions` | WARN when `~/.claude/sessions` does not exist |
| `memory` | WARN when free RAM is below the memory-guard minimum right now. Shows the limits computed for this machine |
| `slots` | WARN when a slot's owner has died; the next `bulkhead-slot run` reclaims it |
| `event log` | Shows its size and event count, or that it is off and why |
| `git` | WARN when git is not on `PATH`; checkout-guard and the git rules of basics then pass everything |
| `remote tools`, `remote <name>` | Only when remotes are configured. FAIL when `ssh`, `tar` or `git` is missing here, or a remote cannot be reached, lacks git or tar, or its folder is not writable |

```
$ bulkhead doctor
OK    node            v24.11.0
OK    plugin          ~/.claude/plugins/cache/bulkhead/bulkhead/0.1.0, hooks: 2 SessionStart, 1 SessionEnd, 6 PreToolUse
OK    state dir       ~/.claude/bulkhead is writable
OK    config          no config files, defaults in use
OK    kill-guard      on
OK    wait-guard      on, limit 180s
OK    memory-guard    on
OK    port-guard      on
OK    checkout-guard  on
OK    basics          on, protected branches: main, master
OK    orphan-reaper   on, at session start and after each session ends
OK    hook run        kill-guard blocked a test command in 90 ms
OK    processes       356 processes, 21 listening ports, 8 Claude sessions in 2.4s
OK    sessions        ~/.claude/sessions (8 session files)
OK    memory          12.2 of 31.8 GB free, commit 43%, memory-guard blocks heavy commands below 3 GB, bulkhead-slot keeps 5 GB free for a second job, and waits while commit is above 75%
OK    slots           none held
OK    event log       ~/.claude/bulkhead/events.jsonl, empty so far
OK    git             2.52.0.windows.1

18 OK, 0 WARN, 0 FAIL
```

## bulkhead config

```
bulkhead config [--json]
```

Prints which config files were found, every setting with its effective value, and where that value came from: `default`, a file path, or `env NAME`. Values left at their default are dimmed in a terminal. Problems with the files are listed at the end as `WARN` lines. See [configuration.md](configuration.md) for the keys.

```
$ bulkhead config
Files (project wins over global, environment wins over both)
  global   ~/.claude/bulkhead/config.json  loaded
  project  ~/src/acme-web/.claude/bulkhead.json  loaded

KEY                            VALUE               FROM
killGuard.enabled              true                default
killGuard.allowNames           ["ffmpeg"]          ~/.claude/bulkhead/config.json
waitGuard.limitSeconds         300                 ~/src/acme-web/.claude/bulkhead.json
memory.minFreeGb               2                   env BULKHEAD_MIN_FREE_GB
...
```

## bulkhead port

```
bulkhead port [--near PORT] [--json]
```

Prints the first port at or above `PORT` (default 3000) that nothing listens on, and nothing else, so it can be used inline:

```
npm run dev -- --port $(bulkhead port --near 3000)
```

A port counts as free only when it can be bound on `127.0.0.1`, `0.0.0.0`, `::1` and `::`; on Windows a server on one of these does not stop a bind on another. Ports that browsers refuse to open (such as 5060, 6000 and 6665 to 6669) are skipped. It tries 1000 ports and exits 1 when none is free. No process scan is needed, so it answers in well under a second.

port-guard's block messages suggest it.

## bulkhead reap

```
bulkhead reap [--dry-run] [--json]
```

Runs [orphan-reaper](guards/orphan-reaper.md) now, over every Claude Code session that has exited. It stops their dev servers and anything else listening, test runners and their workers, watchers, builders and automation browsers that were started from a Claude tool shell, and records each stop in the event log with `trigger: "manual"`. It runs even when orphan-reaper is turned off for the hooks.

`--dry-run` stops nothing and prints, for each tree, the process that matched, its rule, why its session counts as exited, and how many processes would go:

```
would stop 30112  test-runner  node ~/src/acme-web/node_modules/vitest/dist/workers/forks.js
  Vitest and its worker pool (tinypool); its session has exited and removed snapshot-bash-1791860359256-ezwkie.sh; 6 processes from 30080
1 tree would be stopped. Run `bulkhead reap` to stop it.
```

`--json` prints `{ supported, dryRun, orphans: [{ pid, name, rule, what, why, owner, top, pids, command }] }`, where `pids` lists every process in the tree. A run inside a live session never touches that session's own processes. Exit code 1 means the process table could not be read or the platform is not supported.

## bulkhead-slot

```
bulkhead-slot run [--gb=N] [--wait=MINUTES] [--label=TEXT] -- <command...>
bulkhead-slot status [--gb=N]
```

`bulkhead slot ...` is the same. `run` waits until the machine has room for a job of N GB (default 3), runs the command, and releases the slot when it exits, fails or is interrupted. The exit code is the command's; 3 means it gave up waiting after `--wait` minutes (default 30). While it waits, the job is listed in `bulkhead status` and `bulkhead top` with the reason.

## bulkhead remote

```
bulkhead remote run [--remote=NAME] [--gb=N] [--wait=MINUTES] [--files=a,b] [--tail=N]
                    [--fetch=PATH,...] [--label=TEXT] [--project=NAME] -- <command...>
bulkhead remote fetch <path> [<local dir>] [--copy=LETTER] [--remote=NAME] [--project=NAME]
bulkhead remote status [--remote=NAME] [--json]
bulkhead remote list [--json]
bulkhead remote add <name> <user@host> [--shell=CMD] [--dir=PATH] [--copies=N] [--max-jobs=N]
                    [--min-free-gb=N] [--ssh-option=KEY=VALUE]... [--default] [--no-check]
bulkhead remote remove <name>
```

Optional. `run` sends the repository's `HEAD` commit and uncommitted changes to another machine, runs the command there in a copy of its own with `BULKHEAD_PORT` and `BULKHEAD_COPY` set, stops what the command left running, and passes its exit code back. 3 means no free copy, job slot or RAM within `--wait` minutes (default 60), 4 a failed transfer or setup, 5 an unreachable remote. `--tail=N` keeps the full output in `<state dir>/remote-logs/` and prints the last N lines.

```
$ bulkhead remote run --tail=20 -- npm test
[bulkhead remote] buildbox: 3f2a1c9 already there, 3 changed files (24 KB), 1 deleted
[bulkhead remote] buildbox  copy a  /home/dev/bulkhead-remote/acme-web-3f9a1c  port 7172
[bulkhead remote] last 20 lines of output; full log: ~/.claude/bulkhead/remote-logs/20261013-141502-acme-web-3f9a1c.log
...
[bulkhead remote] exit 0 after 1m 12s (copy a)
```

Setup, every option, how copies, locks and ports work, Windows remotes and security are in [remote.md](remote.md).
