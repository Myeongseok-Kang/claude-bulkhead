# bulkhead remote: run heavy jobs on another machine

[Back to README](../README.md)

`bulkhead remote` sends the repository you are in to another machine over SSH and runs a command there. The test suite, the build or the browser run uses that machine's RAM and CPU, and your sessions keep working on this one. The exit code comes back as if the command had run here.

It is optional. Nothing changes until you configure a remote, and the guards never connect anywhere on their own.

```
bulkhead remote run -- npm test
```

```
[bulkhead remote] buildbox: 3f2a1c9 already there, 3 changed files (24 KB), 1 deleted
[bulkhead remote] buildbox  copy a  /home/dev/bulkhead-remote/acme-web-3f9a1c  port 7172
...test output...
[bulkhead remote] exit 0 after 1m 12s (copy a)
```

## When to use it

- Several Claude Code sessions want to run test suites, builds or Playwright at the same time, and this machine runs out of RAM. memory-guard blocks them, or bulkhead-slot makes them queue.
- You have a second machine that is mostly idle: a desktop, a home server, an old laptop, a cloud VM.
- The job is a command with a result: tests, a build, a type check, an end-to-end run against a dev server it starts itself.

It is not a remote development environment. Your editor, your sessions and your dev servers stay here. Use it for jobs that start, finish and report.

## Setup

The remote needs an SSH server, `bash`, `git` and `tar`. Nothing else is installed there: bulkhead sends its own scripts on each connection. This machine needs `ssh`, `git` and `tar` on `PATH` (Windows 10 and later include `ssh` and `tar`; Git for Windows adds both too).

1. Make a key and allow it on the remote, so `ssh` connects without a password prompt:

   ```
   ssh-keygen -t ed25519 -f ~/.ssh/buildbox
   ssh-copy-id -i ~/.ssh/buildbox.pub dev@192.168.1.20
   ```

   On Windows without `ssh-copy-id`, append the contents of `buildbox.pub` to `~/.ssh/authorized_keys` on the remote (`C:\ProgramData\ssh\administrators_authorized_keys` for an administrator account on a Windows remote).
2. Connect once by hand, so the host key is in `known_hosts`: `ssh -i ~/.ssh/buildbox dev@192.168.1.20 exit`. bulkhead runs ssh with `BatchMode=yes`, so it never answers a host key or password prompt itself.
3. Add the remote:

   ```
   bulkhead remote add buildbox dev@192.168.1.20 --ssh-option=IdentityFile=~/.ssh/buildbox
   ```

   It is saved in the global config file and checked right away:

   ```
   added remote buildbox (dev@192.168.1.20) in ~/.claude/bulkhead/config.json
   buildbox: dev@192.168.1.20 reachable in 0.4s, bash 5.2.21, git 2.43.0, tar, /home/dev/bulkhead-remote writable, 27.9 of 31.3 GB free
   ```
4. `bulkhead doctor` checks every configured remote from now on: reachable, bash, git and tar present, the folder writable. `bulkhead doctor --no-remote` skips those checks.

Options for `add`:

| Option | Default | Meaning |
|---|---|---|
| `--shell=CMD` | `bash` | The program that runs bulkhead's script on the remote. For Windows, see [Windows remotes](#windows-remotes) |
| `--dir=PATH` | `~/bulkhead-remote` | Where the copies, locks and port blocks live on the remote |
| `--copies=N` | `4` | Copies of each project, 1 to 8. The most jobs one project can run there at once |
| `--max-jobs=N` | `4` | Jobs the remote runs at once, across all projects |
| `--min-free-gb=N` | `0` | Free RAM the remote must keep. A job waits while starting it would go below this |
| `--ssh-option=KEY=VALUE` | | Any `ssh -o` option, repeatable: `IdentityFile=~/.ssh/buildbox`, `Port=2222`, `User=dev`, `ProxyJump=bastion`, `HostKeyAlias=buildbox` |
| `--default` | | Use this remote when several are configured and `--remote` is not given |
| `--no-check` | | Save without connecting |

A host alias from `~/.ssh/config` works too: `bulkhead remote add buildbox buildbox`. Running `add` again with the same name replaces that remote. `bulkhead remote list` shows them, and `bulkhead remote remove buildbox` deletes one from the config (the copies on the remote stay).

## Running jobs

```
bulkhead remote run [--remote=NAME] [--gb=N] [--wait=MINUTES] [--files=a,b] [--tail=N]
                    [--fetch=PATH,...] [--label=TEXT] [--project=NAME] -- <command...>
```

The command runs with `bash -c` in the same folder of the repository you are in here, so running from `packages/web` runs there too.

```
# the test suite
bulkhead remote run -- npm test

# install first; npm ci is run as npm install (see Copies)
bulkhead remote run -- 'npm ci && npm run build'

# Playwright against a dev server the command starts on its own port
bulkhead remote run --gb=4 -- 'npm run dev -- --port $BULKHEAD_PORT & npx wait-on tcp:$BULKHEAD_PORT && PORT=$BULKHEAD_PORT npx playwright test'

# send an ignored file the tests need
bulkhead remote run --files=.env.test -- npm run test:integration

# keep the output short and bring the report back
bulkhead remote run --tail=40 --fetch=playwright-report -- npx playwright test
```

| Option | Meaning |
|---|---|
| `--remote=NAME` | Which remote. Optional with one remote, or with `remote.default` set |
| `--gb=N` | How much RAM the job needs at its peak. It waits while the remote's free RAM minus N would go below `minFreeGb`. Default 0 |
| `--wait=MINUTES` | How long to wait for a free copy, a job slot and RAM. Default 60. `--wait=0` fails at once with exit 3 |
| `--files=a,b` | Files or folders to send although git ignores them, relative to the current folder. Repeatable |
| `--tail=N` | Write the full output to a log file and print only the last N lines and the log path |
| `--fetch=PATH,...` | After the command, copy these paths back into the current folder, before the copy is released |
| `--label=TEXT` | What `bulkhead remote status` shows for the job. Default: the command |
| `--project=NAME` | The folder name on the remote, used as given. Default: the repository's folder name and its id, such as `acme-web-3f9a1c` (see [Copies](#copies)) |

With one argument after `--`, it is a shell line as you would type it. With several, they are quoted back together, so `-- bash -c "a && b"` keeps its quotes. Quote `$BULKHEAD_PORT` in single quotes so your local shell does not expand it.

### Fetching results

```
bulkhead remote fetch <path> [<local dir>] [--copy=LETTER] [--remote=NAME] [--project=NAME]
```

Copies a file or folder from a copy on the remote into a local folder (default: the current one). The path is relative to the same folder the command ran in. Run it inside the repository, or name the project with `--project`. Without `--copy`, it reads the copy this project's last run used. Another job may take that copy and reset it, so for results you always want, use `--fetch` on `run`, which copies them while the job still holds the copy.

Both stream through ssh with tar, so they work the same with every server and need no remote path syntax.

### Status

```
$ bulkhead remote status
buildbox  dev@192.168.1.20  reachable in 0.4s  21.4 of 31.3 GB free  /home/dev/bulkhead-remote
  HELD              AGE    GB  FROM     LABEL
  job-1                    3 min  4   devbox   npx playwright test
  lock-acme-web-3f9a1c-a   3 min  4   devbox   npx playwright test
  copies: acme-web-3f9a1c, acme-web-3f9a1c-b
```

`--json` gives the same for scripts. The exit code is 5 when a remote cannot be reached.

## How it works

### Transfer

1. bulkhead asks the remote which commits its copy of the project already has.
2. If the remote lacks your `HEAD` commit, it sends a git bundle of only the commits the remote does not have. The first run sends the whole history; later runs send a few KB.
3. Uncommitted work goes as a tar of the files that differ from `HEAD` (staged or not) and the untracked files git does not ignore. Files you deleted are deleted on the remote.
4. Both go in one ssh connection, then a second connection runs the job.

Ignored files (`.env`, `node_modules`, build output) are never sent unless you name them in `--files`, and bulkhead prints the ones it sent that way. A file sent with `--files` stays in that copy, like any ignored file, until you delete it there. It refuses to run when the repository is your home folder or a drive root.

Submodules are not sent, and the copies do not check them out. Git LFS files arrive as whatever the remote's git makes of them: the real files if git-lfs is installed there and can reach your LFS server, pointer files otherwise.

### Copies

Each project gets up to `copies` folders on the remote: `<dir>/<project>` (copy a), `<dir>/<project>-b`, and so on. The project name is the repository's folder name and a six-digit id, such as `acme-web-3f9a1c`. Copy a is a git repository; the others are `git worktree`s of it, so one fetch serves them all. A job takes the first free copy, preferring ones that exist, since making a new one costs a checkout.

Before the command, the copy is checked out at your commit with `git checkout -f --detach` and cleaned with `git clean -fdq -e node_modules`, then your changed files are unpacked over it. Ignored files stay, so dependencies and caches survive from one run to the next. Copies are never deleted.

`node_modules` folders in the top three levels of copy a are linked into the other copies (a symlink, or a junction on Windows), so one install serves every copy. Because of that, `npm ci` and `npm clean-install` in the command run as `npm install --no-audit --no-fund`: `npm ci` deletes `node_modules` first, which would pull it out from under jobs running in the other copies.

The id keeps two repositories with the same folder name (two projects called `web` or `app`) apart, so their histories and `node_modules` never mix. It is a hash of this machine's name and the real path of the repository's git folder, computed on the first run and saved in the repository's own git config as `bulkhead.remoteid`. So:

- Worktrees of one repository share one git folder, so they share the id and the copies.
- Moving the repository to another folder keeps the id. Renaming its folder keeps the id but changes the name part, so the next run makes new copies.
- Two clones of the same repository, on this machine or on two machines, get different ids and their own copies.

`--project=NAME` uses NAME as the folder name instead, with no id, for example to let two clones share copies on purpose. A name ending in `-a` to `-h` is refused, since copies b to h are named that way.

### Locks and room

Before it changes anything, a job takes:

- a job slot, `<dir>/jobs/job-<n>`, one of `maxJobs` for the whole remote;
- the copy, `<dir>/lock-<project>-<letter>`;
- when `--gb` or `minFreeGb` is set, RAM: free RAM, minus the declared size of jobs that started in the last 150 seconds, minus this job's `--gb`, must stay at or above `minFreeGb`.

Each lock is a folder made with `mkdir`, which is atomic. If any of them is not available, the job waits and checks again every 30 seconds, up to `--wait` minutes, then exits 3 and names who holds what. While a job runs, it writes a heartbeat into its locks once a minute. A lock is removed as stale when its process is gone, when it was taken before the remote last booted, or when its heartbeat is more than 6 hours old. Only one waiting job at a time decides that a lock is stale (a `<lock>.reclaim` folder held for a moment), so two waiters never both remove it and both take the copy.

Free RAM on the remote is `MemAvailable` on Linux, an estimate from `vm_stat` on macOS, and available physical memory on Windows.

### Ports

Each copy gets its own port in `BULKHEAD_PORT`, and its letter in `BULKHEAD_COPY`. A server the command starts must listen on `BULKHEAD_PORT`, so that parallel jobs never fight over a port.

Ports come in blocks of 8 from 7100: block n covers `7100 + 8n` to `7107 + 8n`, and copy a uses the first port of the block, copy b the second, and so on. A project gets a block the first time it runs on a remote, starting from a hash of its name and moving to the next free block, and keeps it in `<dir>/ports/<n>`. Two projects never share a block, for up to 100 projects per remote. When all 100 are taken, a block whose project folder has been deleted from the remote goes to the new project. The range stays clear of 5000 (used by macOS) and of ports browsers refuse to open.

If something already listens on the port when the job starts, bulkhead says so and leaves it alone.

### When the command ends

1. Whatever is left in the command's process group (a dev server started with `&`, a watcher) is stopped.
2. Whatever still listens on `BULKHEAD_PORT` and did not before the job is stopped by PID: `lsof`, `fuser` or `ss` on Linux and macOS, `netstat -ano` and `taskkill /PID` on Windows. A server left running would otherwise keep the ssh session open long after the results are in.
3. The locks are released, also on errors and on Ctrl-C.

### When the connection drops

The job runs in its own process group. Next to it, a watcher reads the ssh connection. If this side goes away (Ctrl-C, a tool call that timed out and was killed, a closed laptop lid, a dropped network), the watcher sees the end of the connection, stops the job and everything it started, and releases the copy. A job never keeps running for hours with nobody waiting for it.

After a sudden network loss, it can take a few minutes for the remote to notice, depending on its sshd's keepalive settings (`ClientAliveInterval`).

## Exit codes

| Code | Meaning |
|---|---|
| the command's | The command ran; this is its exit code |
| 2 | Usage error: unknown option, no remote configured, not in a git repository |
| 3 | No free copy, job slot or RAM within `--wait` minutes |
| 4 | Transfer or setup failed: bundle, upload, checkout, or git or tar missing on the remote |
| 5 | The remote cannot be reached, or the connection was lost |

A command that itself exits 3, 4 or 5 is passed through unchanged. The `[bulkhead remote]` lines on stderr tell the cases apart.

## Windows remotes

A Windows machine with the OpenSSH server and [Git for Windows](https://gitforwindows.org) works as a remote. The login shell there is usually `cmd`, so point `shell` at Git Bash, and give `dir` as a Windows path:

```
bulkhead remote add winbox dev@192.168.1.30 --shell="C:\Program Files\Git\bin\bash.exe" --dir=C:/bulkhead-remote --ssh-option=IdentityFile=~/.ssh/winbox
```

- `dir` can be written `C:/bulkhead-remote` or `C:\bulkhead-remote`. bulkhead converts it to the `/c/bulkhead-remote` form Git Bash tools need, and shows it as `C:/...`.
- `node_modules` is shared through directory junctions (`mklink /J`), which need no administrator rights.
- Leftover processes and servers are stopped with `taskkill /PID <pid> /T /F`, by PID only.
- If the login shell is PowerShell instead of cmd, set `--shell="& 'C:\Program Files\Git\bin\bash.exe'"`.

A Windows machine works as the local side too, with Windows OpenSSH or Git for Windows' ssh. Git's own `tar` is used when it is installed, because the `tar.exe` in `System32` cannot read non-ASCII file names from a list.

## Security

- Remotes can only be defined in the global config file, `~/.claude/bulkhead/config.json`. A project's `.claude/bulkhead.json` that sets `remotes` or `remote.default` is ignored with a warning: a repository you clone must not be able to make you connect somewhere, or pass ssh options such as `ProxyCommand`.
- Only files git tracks or would track are sent. Ignored files go only when you name them in `--files`, and every one is listed in the output. Paths outside the repository and inside `.git` are refused, and so is a repository at your home folder, so `~/.claude` and other dotfiles never leave the machine by accident.
- A host may not start with `-`, and ssh options are passed as `-o KEY=VALUE` only.
- Commit IDs the remote reports are checked to be commit hashes before they reach a local git command.
- Everything runs with your SSH account's rights on the remote. Use an account and a folder meant for this.
- `BULKHEAD_SSH` replaces the `ssh` program with another command, given as a JSON array such as `["ssh", "-F", "/path/to/config"]`. The tests use it to run the remote side locally; it also serves wrappers for VPN or jump tools.

## Use from Claude Code

- Run long jobs with `run_in_background: true` and end the turn; Claude Code tells the session when the job exits. A foreground wait holds the session and lets the prompt cache expire, and wait-guard blocks foreground sleeps sent through `bulkhead remote run` the same way it does for `ssh`.
- Add `--tail=40` (or so) for test suites. A full test log can be tens of thousands of lines, and an agent that reads it all spends its context on passing tests. With `--tail`, the session sees the summary and the failures at the end, and the full log is on disk to grep when needed.
- When memory-guard blocks a heavy command and a remote is configured, its message offers `bulkhead remote run -- <command>`.
- Servers in the command must use `$BULKHEAD_PORT`. A server on a fixed port collides with the same job in another copy.
- `bulkhead remote status` shows what is running there before you start more.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `cannot reach buildbox: ssh could not connect ... Permission denied (publickey)` | The key is not allowed on the remote, or `IdentityFile` is wrong. Check with `ssh -o BatchMode=yes -i <key> <host> exit` |
| `... Host key verification failed` | Connect once by hand to accept the host key |
| `` `bash -s` did not run `` | The remote has no `bash` on `PATH` for ssh sessions, or it is a Windows remote without `--shell` set to Git Bash |
| `git is not installed on buildbox` | Install git there, or make sure it is on `PATH` for non-interactive ssh sessions |
| `node: command not found` in the job | A version manager (nvm, fnm, asdf) sets `PATH` in an interactive startup file that ssh commands do not read. Put its setup above the "not interactive" check in `~/.bashrc`, or call it in the command: `-- 'source ~/.nvm/nvm.sh && npm test'` |
| `node: command not found` on a macOS remote | Homebrew's folder is added to `PATH` in `~/.zprofile`, which ssh commands do not read. Add `eval "$(/opt/homebrew/bin/brew shellenv)"` to `~/.zshenv` on the remote (zsh is the login shell on macOS) |
| `git is not installed` on a macOS remote | `/usr/bin/git` there only offers to install the command line tools. Run `xcode-select --install` on it once |
| `this repository is a shallow clone` | git cannot bundle a shallow history. Run `git fetch --unshallow` once |
| exit 3 after waiting | `bulkhead remote status` shows who holds the copies and slots. Raise `copies` or `maxJobs`, or wait longer |
| A copy is in a bad state | Remove its folder on the remote (`<dir>/<project>` for copy a, `<dir>/<project>-<letter>` for the others) while no job uses it. The next run makes it again. When copy a is removed, the other copies are made again too, since they are worktrees of it |

To remove everything from a remote, delete its `dir` while no job runs there.
