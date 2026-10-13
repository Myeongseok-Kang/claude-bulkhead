# memory-guard and bulkhead-slot

[Back to README](../../README.md) | [All guards](../../README.md#guards)

memory-guard blocks heavy commands when free RAM is low. bulkhead-slot is a small CLI that queues heavy work against one RAM budget that every session on the machine shares.

## Why

Three sessions start a build, a test suite and a browser run in the same minute, and the machine stops responding. See [#15487](https://github.com/anthropics/claude-code/issues/15487): 24 subagent processes saturated a 4 GB VPS until it had to be rebooted.

## memory-guard

### Blocked when free RAM is low

The threshold is 3 GB. On machines with less than 20 GB it is 15% of total RAM instead, so 1.2 GB on an 8 GB laptop. Below it, these are blocked:

```
npx vitest run           jest              npx playwright test     cypress run
./gradlew assembleDebug  gradle build      mvn clean install       ./mvnw test
emulator -avd Pixel_7    dotnet build      dotnet test             tsc -b
next build               next dev          vite build              webpack
npm run build            pnpm test         yarn e2e                cargo build
cargo test               go test ./...     pytest -n auto          docker build .
docker compose up        bazel test //...  turbo build             nx run-many -t test
ffmpeg -i in.mp4 out.webm
```

Scripts that call `chromium.launch` or `launchPersistentContext` count too. Wrappers are opened as in kill-guard, so `bash -c "npm test"`, `sudo docker build .` and `env NODE_OPTIONS=... npx next build` count.

### Always allowed

Light commands, and read-only commands that only mention a heavy tool: `grep -rn vitest package.json`, `cat`, `ls`, `find`, `git` and similar. Also light forms of heavy tools: `pytest` without `-n`, `mvn dependency:tree`, `./gradlew tasks`, `go test ./internal/auth`, `vite preview`, `next start`, and commands run on another machine or in a container (`ssh host npm test`, `docker exec web npm test`).

### Hand edits to slot files

memory-guard also blocks commands that write, touch, move or delete files in the slot directory by hand. A forgotten background loop that kept rewriting one slot file held a slot long after its tests had finished.

### What Claude sees

```
[bulkhead] memory-guard: only 1.8 GB of RAM is free (minimum 3 GB) and this looks like a heavy command.
Other sessions are probably building or testing right now. Starting more work at this point is how machines freeze.
Either wait a minute and retry with fewer workers (for example --maxWorkers=2), or queue it:
  bulkhead-slot run --gb=3 -- <command>
bulkhead-slot waits until there is room, runs the command, and frees the slot when it exits.
```

## bulkhead-slot

The plugin puts `bulkhead-slot` on the Bash tool's `PATH`.

```
bulkhead-slot run --gb=4 -- npx playwright test
bulkhead-slot run --gb=3 --wait=20 --label="unit tests" -- npm test
bulkhead-slot status
```

`--gb` is how much RAM the job is expected to use (default 3). `--wait` is how many minutes to wait for room (default 30); exit code 3 means it gave up. `--label` is the name shown in `bulkhead status`.

While a job waits, it is written to `<state dir>/queue/<pid>.json`, so `bulkhead status` and `bulkhead top` list it with the reason it waits. The file is removed when the job starts, gives up or exits.

### When a job starts

- The first job starts when free RAM is at least the memory-guard minimum (3 GB, or 15% of RAM on smaller machines).
- A further job starts only if, after subtracting the new job and any job started in the last 150 seconds (which has not reached its peak yet), 5 GB (or 25% of RAM) would still be free.
- On Windows it also waits while commit charge is above 75%. Windows can stall when commit charge runs out even while physical memory still looks free.
- Machines with less than 24 GB run one heavy job at a time.

The command's exit code is passed through. The slot is released when the command exits, fails or is interrupted. A slot whose owner process has died is reclaimed by the next caller.

### How free RAM is measured

- Linux: `MemAvailable` from `/proc/meminfo`.
- Windows: available physical memory, plus commit charge from `Win32_OperatingSystem`.
- macOS: `os.freemem()` is close to zero on a healthy machine, so bulkhead estimates what Activity Monitor shows from `vm_stat`: total minus app memory (anonymous minus purgeable pages), wired and compressed pages.

Slot files live in `~/.claude/bulkhead/slots`.

## Turn off or tune

| Variable | Default | Meaning |
|---|---|---|
| `BULKHEAD_DISABLE=memory-guard` | | Turns memory-guard off. bulkhead-slot is only used when you or Claude call it |
| `BULKHEAD_MIN_FREE_GB` | 3, or 15% of RAM if less | Free RAM below which memory-guard blocks |
| `BULKHEAD_SLOT_FLOOR_GB` | 5, or 25% of RAM if less | RAM bulkhead-slot keeps free when it starts a second job |
| `BULKHEAD_MAX_COMMIT_PCT` | 75 | Windows commit charge above which bulkhead-slot holds a second job |

The same thresholds can be set in a config file as `memory.minFreeGb`, `memory.slotFloorGb` and `memory.maxCommitPct`, and `"memoryGuard": { "enabled": false }` turns memory-guard off. See [configuration](../configuration.md).

## Limits

- Only RAM is measured. CPU, disk and GPU are not limited.
- bulkhead-slot is only used when called. Nothing forces every session to queue through it.
- The heavy command list is fixed and matched on command text.
- On Windows, `bulkhead-slot` runs through Git Bash when it is installed and through `cmd.exe` otherwise.
