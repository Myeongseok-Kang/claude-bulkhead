# kill-guard

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Runs before every Bash and PowerShell call. It stops an agent from killing a program by name when other sessions, subagents or you are running the same program.

## Why

On a machine with several sessions, `node`, `python` and `chrome` belong to many owners at once. An agent asked to restart its own dev server often reaches for the shortest command, and the shortest command kills everyone's. See [#13941](https://github.com/anthropics/claude-code/issues/13941), [#34754](https://github.com/anthropics/claude-code/issues/34754), [#43225](https://github.com/anthropics/claude-code/issues/43225) and [#53229](https://github.com/anthropics/claude-code/issues/53229).

## Blocked

Commands that kill a shared program by name or by filter:

```
taskkill /F /IM node.exe
taskkill /F /FI "IMAGENAME eq python.exe"
Stop-Process -Name node -Force
Get-Process node | Stop-Process
pkill node
pkill -9 -f python
killall chrome
kill $(pgrep node)
ps aux | grep node | xargs kill
wmic process where name="node.exe" delete
```

These are blocked too:

```
pkill -s KILL -u $USER node                          # options that take a value are skipped
killall node python                                  # every name is checked
for pid in $(pgrep node); do kill $pid; done         # a name lookup that feeds a kill
ps aux | grep [n]ode | awk '{print $2}' | xargs kill
taskkill /F /IM node* /IM python.exe                 # wildcards and several /IM
Stop-Process -Name node,python
Get-Process node* | Stop-Process
(Get-Process node).Kill()
Get-Process | Where-Object { $_.Name -eq 'node' } | Stop-Process
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Invoke-CimMethod -MethodName Terminate
```

Wrappers are opened up to three levels deep: `bash -c`, `sh -c`, `zsh -c`, `powershell -Command`, `pwsh -c`, `powershell -EncodedCommand`, `cmd /c`, `eval`, `trap`, `watch`, `su -c`, `Start-Process`, and prefixes such as `env VAR=x`, `VAR=value`, `sudo`, `nohup`, `time`, `nice`, `timeout N` and `xargs`. So `sudo pkill node` and `cmd /c "taskkill /F /IM node.exe"` are blocked as well.

Shared programs include `node`, `python`, `python3`, `py`, `ruby`, `java`, `dotnet`, `chrome`, `chromium`, `msedge`, `firefox`, `bash`, `sh`, `zsh`, `powershell`, `pwsh`, `cmd`, `git`, `ssh`, `code`, `claude`, `npm`, `npx`, `pnpm`, `yarn`, `deno`, `bun`, `tsx`, `gradle`, `adb`, `ffmpeg`, `docker`, `vitest`, `jest`, `next`, `vite`, `esbuild` and `webpack`, with or without `.exe`.

## Allowed

```
kill 24632
taskkill /PID 24632 /T /F
Stop-Process -Id 24632
lsof -ti :3000 | xargs kill            # by port, unless another session owns it (port-guard)
fuser -k 3000/tcp
pkill -f ~/src/acme-web/server.js      # by project path or script file
taskkill /IM qemu-system-x86_64.exe    # a name nobody else shares
kill -0 24632                          # signal 0 only checks
pgrep -f "$PWD/server.js" | xargs kill # a lookup scoped to your own script path
Get-Process node | Where-Object { $_.Path -like '*\acme-web\*' } | Stop-Process   # filter by Id, CommandLine or Path
ssh build-host "pkill node"            # runs on another machine
docker exec web pkill node             # runs inside a container (also kubectl, podman exec)
```

Kill commands inside `echo`, `grep`, `git` or `cat` text, inside a heredoc written to a file, and inside commit, pull request and release text (`-m`, `--message`, `--title`, `--body`, `--notes`, `-F` with a heredoc) are not executed and pass.

## What Claude sees

```
[bulkhead] kill-guard: taskkill /IM kills every process with that name: taskkill /F /IM node.exe
Other Claude sessions, subagents and the user run these programs on this machine too. Killing by name takes down their dev servers, test runs and builds, and can end your own session.
Stop only the processes you started, by PID:
By port: netstat -ano | findstr :<port>   (last column is the PID)
By project: Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*<your project dir>*' } | select ProcessId, CommandLine
Then: taskkill /PID <pid> /T /F
```

On Linux and macOS the hints are `lsof -ti :<port>`, `pgrep -af '<your project dir>'` and `kill <pid>`.

## Turn off or tune

- `BULKHEAD_DISABLE=kill-guard`, or `"killGuard": { "enabled": false }` in a config file, turns it off.
- `killGuard.allowNames` takes names off the shared list, so killing them by name passes, for example `["ffmpeg"]`.
- `killGuard.extraSharedNames` adds names that must not be killed by name, for example `["postgres", "redis-server"]`.

See [configuration](../configuration.md).

## Limits

- A program missing from the shared list is not protected. Add it with `killGuard.extraSharedNames`.
- It reads command text. A kill inside a script file, a shell function or an alias is not seen. Wrappers nested more than three levels deep are not opened.
