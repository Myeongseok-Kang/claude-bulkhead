# FAQ

[Back to README](../README.md)

## Does it slow Claude Code down?

A little. Each guard is one short Node process with no dependencies. On a Windows 11 desktop with Node 24, `node scripts/bench-hooks.js 15` measured 40 to 49 ms per guard on an allowed command (median of 15 runs), and 33 ms for starting Node alone. Writing a block to the event log adds no measurable time. The guards only do slow work after the command text matches: port-guard reads the process list (a second or two on Windows) only when a dev server start or a kill-by-port hits a port that already answers, checkout-guard runs git only when another session is alive, and basics runs `git status` only for `reset --hard` and `clean`. The status line takes under 100 ms and is cached for 5 seconds. See [architecture](architecture.md#performance).

## It blocked something it should not have. What do I do?

1. Run `bulkhead log` (or `/bulkhead:log` inside Claude Code) to see the exact command and the reason.
2. Let it through in the project config, `<repo>/.claude/bulkhead.json`: `killGuard.allowNames` for a program name, `portGuard.ignorePorts` for a port every session shares, `waitGuard.limitSeconds` for a longer wait, `basics.protectedBranches` for branches. Or turn the guard off for that project with `"<guard>": { "enabled": false }`. See [configuration](configuration.md).
3. Or turn the guard off: `BULKHEAD_DISABLE=<guard>` in the `env` block of `~/.claude/settings.json`.
4. Please open a [false positive issue](https://github.com/Myeongseok-Kang/claude-bulkhead/issues/new?template=false-positive.yml) with the line from `bulkhead log` and the command you expected to pass, so the pattern can be fixed for everyone.

## Is it useful with a single session?

Yes. kill-guard, wait-guard, memory-guard and basics protect one session and its subagents just as well. A subagent that kills `node` by name can end its own parent session. port-guard and checkout-guard only act when another session is alive. orphan-reaper cleans up servers, test workers and watchers left by sessions that have exited.

## Which systems does it support?

| | Windows | Linux | macOS |
|---|---|---|---|
| kill-guard, wait-guard, basics, checkout-guard | yes | yes | yes |
| memory-guard, bulkhead-slot | yes | yes | yes, free RAM estimated from `vm_stat` |
| port-guard, `bulkhead status` | yes | yes | yes, through `ps` and `lsof` |
| orphan-reaper | yes | yes, needs `CLAUDE_PID` in tool shells | yes, tested with fixtures, not yet on a real Mac |

Node 18 or later is required on all three. On Windows, `bulkhead-slot` runs commands through Git Bash when it is installed and through `cmd.exe` otherwise.

## Does it send anything anywhere?

No. There is no telemetry and no network call. The only socket it opens is port-guard's connection attempt to `localhost` to see whether a port answers. The block logs (`guards.log`, `events.jsonl`) stay in the state directory on your machine. The one exception is `bulkhead remote`, which connects over SSH to a machine you configured, and only when you run it.

## I have a second machine. Can the heavy jobs run there?

Yes, with `bulkhead remote`. Add the machine once with `bulkhead remote add buildbox dev@192.168.1.20 --ssh-option=IdentityFile=~/.ssh/buildbox`, then run `bulkhead remote run -- npm test` instead of `npm test`. It sends the commit and your uncommitted changes, runs the command in a copy of its own with its own port, and returns the exit code. The remote needs only an SSH server, bash, git and tar. See [remote.md](remote.md).

## What happens to a remote job when I press Ctrl-C or the tool call times out?

It stops. The remote side watches the SSH connection, and when it closes, it stops the job and everything the job started, and frees the copy for the next run. A server the command left on `BULKHEAD_PORT` is stopped too, even when the command ends normally.

## Can Claude get around it?

Yes, if it tries. The guards read command text with regular expressions. A kill or a sleep inside a script file, an alias or an encoded command is not seen. The goal is to catch the common shapes an agent reaches for when it is not thinking about other sessions, and to tell it what to do instead. Each message names the safer command, such as a kill by PID, a background loop or a worktree.

## Why did kill-guard let `lsof -ti :3000 | xargs kill` through?

A port usually names one server, so kill-guard allows kills by port. port-guard checks who owns that port and blocks the kill when the server belongs to another Claude session.

## Why is the RAM number different from my task manager?

memory-guard uses what the OS calls available memory: `MemAvailable` on Linux, available physical memory on Windows, and an Activity Monitor style estimate on macOS. Task managers often show "free" memory, which leaves out reclaimable cache. On Windows, bulkhead-slot also watches commit charge, because Windows can stall when commit charge runs out while plenty of physical memory still looks free.

## Does bulkhead-slot limit what a job actually uses?

No. `--gb` is a reservation that other sessions see, not a cap. The job can use more. Pick a number close to the job's peak. bulkhead-slot also counts any job started in the last 150 seconds as not having reached its peak yet.

## Do I have to use bulkhead-slot?

No. Nothing forces a session to queue through it. memory-guard suggests it when it blocks a heavy command, and Claude usually takes the suggestion.

## How do I uninstall it?

```
/plugin uninstall bulkhead@bulkhead
/plugin marketplace remove bulkhead
```

Then delete `~/.claude/bulkhead` (or your `BULKHEAD_STATE_DIR`) and remove the `statusLine` entry from `~/.claude/settings.json` if you added one.
