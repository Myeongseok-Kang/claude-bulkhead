# orphan-reaper

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Stops the heavy processes a Claude Code session left running after it exited: dev servers and anything else listening on a port, test runners and their workers, watchers, builders and automation browsers. It runs right after a session ends and, as a catch-all, in the background when a session starts. It only stops processes started from a Claude Code tool shell, and only once that session is proven gone.

## Why

Processes started by agents outlive them: 60 Node processes in [#11502](https://github.com/anthropics/claude-code/issues/11502) and 550 pytest workers in [#25180](https://github.com/anthropics/claude-code/issues/25180). Each one keeps holding RAM, and servers keep the port that the next session in that worktree will want.

## When it runs

| Event | What happens |
|---|---|
| `SessionEnd` | The hook finds the session's Claude process and starts a hidden, detached waiter, then returns at once. The waiter checks every second whether that process has exited, and then stops the orphans of that session only. It gives up after 3 minutes if the process is still running. |
| `SessionStart` (`startup`, `resume`) | One pass in the background over every session that has exited, for anything the waiter could not handle: a crash, a machine that was shut down, or `orphanReaper.onSessionEnd` set to `false`. |
| `bulkhead reap` | The same pass, by hand. See [Dry run](#dry-run). |

Notes on the Claude Code hook semantics this relies on ([hooks reference](https://code.claude.com/docs/en/hooks)):

- `SessionEnd` receives `session_id`, `cwd` and a `reason`. With `clear` and `resume` the same Claude process keeps running, so no waiter is started. Every other reason (`prompt_input_exit`, `logout`, `other`) starts one.
- `SessionEnd` hooks share a 1.5 second budget and cannot delay the exit. That is why the hook does no process scan itself (one scan takes 1 to 2 seconds on Windows) and leaves all the work to the waiter, which is detached so it survives the exit, and hidden so no console window opens on Windows.
- In current Claude Code versions the hook runs as a direct child of the Claude process, with `CLAUDE_PID` in its environment. The waiter takes the PID and the exact start time from the session file in `~/.claude/sessions`, and falls back to `CLAUDE_PID`.
- `SessionStart` with `clear` or `compact` happens inside a running process, so the startup pass skips them.
- Subagents run inside their parent's Claude process and their shells carry the parent's `CLAUDE_PID`, so a subagent ending proves nothing about its processes. The reaper does not run at `SubagentStop`; what a subagent started is stopped when the whole session exits.

## What it stops

A process is stopped only when it matches a rule below, is not on the keep list, and its Claude session is proven gone ([next section](#how-it-knows-a-session-is-gone)). The whole tree under the topmost Claude tool shell above it is stopped, minus anything on the keep list and everything under such a process. Shells are never matched themselves.

| Rule | What | Why |
|---|---|---|
| `test-runner` | Vitest and its worker pool (tinypool) | One worker per CPU core by default, each holding hundreds of MB; they never exit without their runner. |
| `test-runner` | Jest and jest-worker children | Same worker-per-core pool; a stuck worker keeps its memory forever. |
| `test-runner` | Mocha, including `--parallel` workers | A watch or hung run never exits. |
| `test-runner` | AVA and its workers | One worker process per test file. |
| `test-runner` | `node --test`, `bun test`, `deno test` | The built-in runners start a child per test file. |
| `test-runner` | Playwright Test runner and workers | Each worker drives its own browser. |
| `test-runner` | pytest | A hung test keeps the interpreter and its fixtures alive. |
| `test-runner` | pytest-xdist workers (execnet) | Workers outlive a killed controller; hundreds were reported left behind (anthropics/claude-code#25180). |
| `test-runner` | `cargo test` and `cargo nextest` | Compiles and runs test binaries, several GB while linking. |
| `test-runner` | Rust test binaries (`target/*/deps/<name>-<hash>`) | A hung test binary never exits on its own. |
| `test-runner` | `go test` and its test binaries (`*.test`) | Same: a hung test binary never exits on its own. |
| `test-runner` | `dotnet test` and testhost | The test host stays up while a test hangs. |
| `watcher` | `tsc --watch` | Watchers never exit. |
| `watcher` | Vite, webpack, esbuild, Rollup or Parcel with `--watch` | Watchers never exit. |
| `watcher` | nodemon, `node --watch`, `tsx watch`, ts-node-dev, chokidar | Watchers never exit, and restart their child on every file change. |
| `builder` | `next build` | Several GB for minutes; a second build in the same tree fails while it runs. |
| `builder` | Turborepo task runs (`turbo run`, `turbo build`, ...) | Runs many package builds at once. |
| `builder` | `vite build`, webpack, Rollup and `tsc` one-shot builds | Holds its memory until it finishes, while nobody reads the result. |
| `headless-browser` | Headless or automation browsers (Chrome, Chromium, Edge, Firefox, WebKit) started with `--headless`, a debugging pipe, or a Playwright or Puppeteer profile | Each instance holds hundreds of MB; Playwright and Puppeteer leave them behind when the runner is killed. |
| `dev-server` | Anything listening on a TCP port | Holds the port the next session in that project will want, and its memory. |
| `extra-name` | Program names in `orphanReaper.extraNames` | You listed them. |

The rules are checked in this order, so a Vitest UI that listens on a port is a `test-runner`. The table lives in [src/orphan-reaper.js](../../src/orphan-reaper.js) as `RULES`, and a test checks that every entry is listed here.

### Never stopped

These are never stopped, and neither is anything they started, even under an orphaned tool shell. A candidate whose parent chain passes through one of them is skipped too, so a server you start in the terminal of an editor that Claude opened stays up.

| What | Why |
|---|---|
| Claude Code itself | A session started from a tool shell is a live session of its own. |
| orphan-reaper itself | The reaper and its waiters. |
| Editors and IDEs (VS Code, Cursor, Windsurf, Zed, Sublime Text, JetBrains IDEs, Android Studio, Visual Studio, Vim, Emacs) | `code .` from a tool shell opens your editor; it is yours, not the session's. |
| Terminals and multiplexers (Windows Terminal, iTerm2, GNOME Terminal, kitty, WezTerm, tmux, screen, ...) | A terminal opened from a tool shell is yours, and so is everything you run in it. |
| macOS app bundles that are not automation browsers | GUI apps opened with `open` are yours. |
| Shared build daemons (Gradle, Kotlin, MSBuild node reuse, VBCSCompiler, Bazel, Buck2, sccache, Turborepo and Nx daemons) | Builds in every session connect to the same daemon; stopping it breaks theirs. |
| Shared machine services (adb, the Android emulator, Docker, Ollama, watchman, ssh-agent, gpg-agent) | One instance serves every session on the machine. |
| Program names in `orphanReaper.keepNames` | You listed them. |

## How it knows a session is gone

Only processes started from a Claude Code tool shell are considered. Anything else, such as a server you started in your own terminal, has no Claude shell above it and no `CLAUDE_PID`, and is never touched.

- Linux: the Bash tool exports `CLAUDE_PID`, and every child inherits it. The reaper reads it from `/proc/<pid>/environ`. The session is gone when that PID no longer exists, belongs to a process that is not Claude, or belongs to a process younger than the candidate (a reused PID).
- macOS: the same, reading `CLAUDE_PID` from `ps -axwwE`, which shows the environment of your own processes. When that is not available it uses the Windows method below; a process whose shell has exited is reparented to launchd.
- Windows: there is no reparenting and the environment of other processes cannot be read, so the reaper walks `ParentProcessId` up from the candidate. The chain has to pass through a Claude Bash or PowerShell tool shell and then end at a parent that no longer exists. A parent older than its child is a reused PID and also ends the chain. A live session that started a job with `&` looks the same once the shell wrapper has exited, so one more proof is needed:
  - Bash tool shells name the session's shell snapshot, `~/.claude/shell-snapshots/snapshot-bash-<time>-<id>.sh`, which Claude Code writes at the session's first Bash call and deletes when the session exits. A deleted snapshot means the session has exited, unless a live tool shell of a running session still uses the same snapshot. If the file is still there (the session crashed, or it is alive), the process is only stopped when every running Claude process is younger than the snapshot.
  - PowerShell tool shells carry no snapshot, so at session start they are only stopped after 6 hours.
  - After `SessionEnd` the waiter knows the exact PID and start time of the session that exited. A tool shell whose missing parent is exactly that PID, and that started while it ran, is that session's, PowerShell shells included. A Bash shell whose wrapper exited belongs to it when its snapshot was written during the session and is gone.

Processes are stopped by PID, children first, after one process scan. On Windows that is `taskkill /F /PID`, never `/T`, because `/T` follows parent PIDs without checking start times and could reach an unrelated process whose parent PID was reused. A second scan on Windows stops children that a dying process started in the meantime. On Linux and macOS each process gets `SIGTERM`, and `SIGKILL` if it is still running 3 seconds later.

## Dry run

```
bulkhead reap --dry-run
```

```
would stop 30112  test-runner  node ~/src/acme-web/node_modules/vitest/dist/workers/forks.js
  Vitest and its worker pool (tinypool); its session has exited and removed snapshot-bash-1791860359256-ezwkie.sh; 6 processes from 30080
would stop 31020  dev-server  node ~/src/acme-web/node_modules/vite/bin/vite.js --port 5174
  Anything listening on a TCP port; its Claude session (PID 18672) has exited; 3 processes from 30990
2 trees would be stopped. Run `bulkhead reap` to stop them.
```

`bulkhead reap` without `--dry-run` stops them now, and `--json` prints the same list with every PID that would be stopped. Outside Claude Code, run it by path: `node ~/.claude/plugins/cache/bulkhead/bulkhead/<version>/bin/bulkhead reap --dry-run` (`/plugin` shows the path). `/bulkhead:reap` shows the dry run inside Claude Code.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `orphanReaper.enabled` | `true` | Turns the reaper off at both events. `BULKHEAD_DISABLE=orphan-reaper` does the same |
| `orphanReaper.onSessionEnd` | `true` | `false` leaves only the pass at session start |
| `orphanReaper.extraNames` | `[]` | More program names to stop once their session has exited, such as `["my-server"]` |
| `orphanReaper.keepNames` | `[]` | Program names never to stop, nor anything they started, such as `["mongod"]` |

Names are matched without `.exe` and without regard to case. See [configuration.md](../configuration.md).

## Event log

Every stop is recorded in the event log with its rule, the stopped process's command line and PID, and `trigger`: `session-end`, `startup` or `manual`. After `SessionEnd` the session ID and project are filled in as well. See them with `bulkhead log --guard orphan-reaper`. `guards.log` also records when a waiter gave up.

## Limits

- On Windows, a program started with PowerShell's `Start-Process` has no Claude tool shell above it once that PowerShell call returns, so it is never stopped. Start long-running processes from the Bash tool, or with `run_in_background`.
- On Windows, a session that crashed leaves its snapshot file behind. Its Bash orphans are then only stopped once every running Claude session is younger than that snapshot. Deleting `~/.claude/shell-snapshots` by hand while sessions run makes their `&` jobs look exited.
- On Windows, when the Claude process is terminated from outside instead of exiting (so no `SessionEnd`), its tool shells can disappear while a `run_in_background` job keeps running. Such a job has no Claude tool shell above it any more and is left alone. On Linux and macOS `CLAUDE_PID` still ties it to its session.
- A job that a running session is still using is never stopped, however heavy. The reaper only acts on sessions that have exited.
- The waiter gives up after 3 minutes; the next session start catches anything left.
- Something on the keep list that you did want stopped, such as a Gradle daemon nobody uses, stays up. Its own idle timeout ends it.
- macOS support is tested with fixtures of `ps` output, not yet on a real Mac. On Linux it needs a Claude Code version that sets `CLAUDE_PID` for tool shells.
