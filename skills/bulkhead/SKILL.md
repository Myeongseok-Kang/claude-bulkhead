---
name: bulkhead
description: How to work on a machine where other Claude Code sessions and subagents run at the same time. Use before starting a dev server, stopping or killing a process, freeing a port, running a build, test suite, browser run or other heavy command, switching branches or stashing, or waiting on a long job.
---

# Working on a shared machine

Other Claude Code sessions, their subagents and the user run on this machine too. Their dev servers, test runs and git trees look like yours from a shell. The bulkhead hooks block the most damaging mistakes; this is how to avoid hitting them at all.

## Look before you act

Run `bulkhead status` before you start a server, stop a process or start heavy work. It lists every Claude session with its project, memory, listening ports, the heavy jobs queued in bulkhead-slot, and free RAM.

## Dev servers and ports

- A port listed under another session belongs to that session. Do not stop its server and do not start yours on the same port.
- Get a free port with `bulkhead port --near 3000` and pass it explicitly, for example `npm run dev -- --port $(bulkhead port --near 3000)`.
- Next.js and Vite move to the next port on their own when theirs is taken. Read the port the server prints instead of assuming the default.
- Start long-running servers with `run_in_background: true`, and stop them when you are done.

## Stopping processes

- Stop only processes you started, by PID. Never by program name: `taskkill /IM node.exe`, `pkill node`, `killall python` and `Stop-Process -Name node` stop every session's processes, and can end your own session.
- Find the PID by port (`netstat -ano | findstr :<port>` on Windows, `lsof -ti :<port>` elsewhere) or by your project path (`pgrep -af '<project dir>'`, or `Get-CimInstance Win32_Process` filtered on `CommandLine`). Check that it is yours before stopping it.
- Then `taskkill /PID <pid> /T /F` on Windows, `kill <pid>` elsewhere.
- Kills by port (`npx kill-port`, `fuser -k`, `lsof -ti :N | xargs kill`) are blocked when another session owns that port.

## When the session ends

Servers, test runners and their workers, watchers, builds and headless browsers you start from the Bash tool are stopped by orphan-reaper a few seconds after this session exits. Do not promise the user that a server will keep running after the session; if they want that, they should start it in their own terminal. `bulkhead reap --dry-run` lists what sessions that already exited left running.

## Heavy commands

Builds, full test suites, type checks of large projects, browser automation, emulators and Docker builds can use several GB each. Queue them so sessions take turns instead of freezing the machine:

```
bulkhead-slot run --gb=4 -- npx playwright test
```

`--gb` is the job's honest peak size: about 4 for browser suites, `next build` or an emulator, 3 for a dev server or a 4-worker test run, 2 for one type check. The command waits until there is room, runs, and frees the slot when it exits; its exit code passes through. `bulkhead-slot status` shows who holds slots. Never edit, touch or delete slot files by hand. Limit workers (`--maxWorkers=2`, one browser) when memory is tight.

### On another machine

If `bulkhead remote list` shows a remote, a heavy job can run there instead and use none of this machine's RAM. Prefer it when free RAM is low, when memory-guard blocked the command, or when bulkhead-slot would make you wait:

```
bulkhead remote run --tail=60 --gb=4 -- npx playwright test
```

- Run it with `run_in_background: true` and end your turn. Its exit code is the command's, and `--tail=60` keeps the output to the last 60 lines plus the path of the full log.
- It sends the current commit and the uncommitted changes. An ignored file the job needs (a `.env.test`) goes with `--files=.env.test`.
- A server the command starts must listen on `$BULKHEAD_PORT`, not a fixed port: other runs use the same remote. Everything the command started is stopped when it ends.
- Reports and screenshots stay on the remote. Bring them back with `--fetch=playwright-report` on the run, or `bulkhead remote fetch playwright-report` afterwards.
- Exit 3 means no free copy or RAM there in time, 4 a transfer or setup problem, 5 an unreachable remote. Then run it here through bulkhead-slot instead.

## Waiting

Do not sit in a foreground loop waiting for a long job: the session cannot do anything else meanwhile, and after about five minutes without a request the prompt cache expires. Run the wait with `run_in_background: true` and end your turn; you are notified when it exits. A command ending in `&` also returns at once.

## Git trees

When another session works in the same checkout, `git checkout`, `switch`, `stash`, `reset --hard`, `clean -f`, `rebase` and `merge` change its files under it. Work in your own worktree: `git worktree add ../<repo>-<task> -b <branch>`.

## When a guard blocks you

Read the message: it names the other session and what to do instead. Do not work around it by splitting, encoding or hiding the command. If the block is wrong for this project, tell the user which setting would allow it (`bulkhead config` lists them, for example `killGuard.allowNames` or `portGuard.ignorePorts` in the project's `.claude/bulkhead.json`). `bulkhead log` shows what was blocked.
