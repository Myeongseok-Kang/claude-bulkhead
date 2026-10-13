# Configuration

Every guard works without configuration. When one gets in the way of a project, change that one setting for that project instead of turning the guard off everywhere.

## Where settings come from

From lowest to highest priority:

1. Built-in defaults.
2. The global file, `~/.claude/bulkhead/config.json` (`$BULKHEAD_STATE_DIR/config.json` when that variable is set).
3. The project file, `.claude/bulkhead.json` in the project. It is looked up from the project directory (`CLAUDE_PROJECT_DIR`, else the working directory) upward, and the search stops at the first folder that contains `.git` or at the home directory. A key set here replaces the same key from the global file; lists are replaced, not merged.
4. Environment variables. They always win. Set them in the `env` block of `~/.claude/settings.json` to apply them to every session.

`bulkhead config` prints the value of every key and which of these it came from.

Both files are plain JSON (no comments) with one object per section. [`config.example.json`](../config.example.json) at the repository root sets every key:

```json
{
  "killGuard": { "allowNames": ["ffmpeg"], "extraSharedNames": ["postgres"] },
  "portGuard": { "ignorePorts": [9229] },
  "basics": { "protectedBranches": ["main", "master", "release"] }
}
```

## Broken files

A file that is not valid JSON is ignored as a whole, and every guard keeps the values it would have without that file. Nothing is blocked because of a typo, and nothing is turned off either. At the start of each session, Claude Code shows one notice:

```
[bulkhead] config problem, defaults are used where it applies:
  ~/.claude/bulkhead/config.json is not valid JSON (Expected double-quoted property name in JSON at position 41); it is ignored until fixed
Run `bulkhead config` or `bulkhead doctor` to check.
```

An unknown key, or a value of the wrong type, is dropped on its own with a warning; the rest of the file still applies. `bulkhead config` and `bulkhead doctor` list every warning.

## Keys

### killGuard

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns kill-guard on or off |
| `allowNames` | list of names | `[]` | Names taken off the shared list, so killing them by name passes. `ffmpeg` and `ffmpeg.exe` are the same name |
| `extraSharedNames` | list of names | `[]` | More names that must not be killed by name, such as `postgres` or `redis-server` |

The built-in shared list is: node, python, python3, py, pythonw, ruby, java, javaw, dotnet, chrome, chromium, chrome-headless-shell, msedge, firefox, bash, sh, zsh, powershell, pwsh, cmd, conhost, git, ssh, sshd, code, claude, npm, npx, pnpm, yarn, deno, bun, tsx, ts-node, gradle, adb, ffmpeg, docker, vitest, jest, next, vite, esbuild, webpack.

### waitGuard

| Key | Type | Default | Environment | Meaning |
|---|---|---|---|---|
| `enabled` | boolean | `true` | | Turns wait-guard on or off |
| `limitSeconds` | number | `180` | `BULKHEAD_WAIT_MAX_SEC` | Longest foreground wait allowed |

### memoryGuard and memory

| Key | Type | Default | Environment | Meaning |
|---|---|---|---|---|
| `memoryGuard.enabled` | boolean | `true` | | Turns memory-guard on or off |
| `memory.minFreeGb` | number | 3, or 15% of RAM if less | `BULKHEAD_MIN_FREE_GB` | Free RAM below which memory-guard blocks heavy commands, and the first bulkhead-slot job waits |
| `memory.slotFloorGb` | number | 5, or 25% of RAM if less | `BULKHEAD_SLOT_FLOOR_GB` | RAM bulkhead-slot keeps free when it starts a second job |
| `memory.maxCommitPct` | number | `75` | `BULKHEAD_MAX_COMMIT_PCT` | Windows only: commit charge above which bulkhead-slot holds a second job |

`bulkhead doctor` shows the values computed for the machine it runs on.

### portGuard

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns port-guard on or off |
| `ignorePorts` | list of port numbers | `[]` | Ports port-guard never checks, for starting a server or for a kill by port. Useful for a port every session shares on purpose, such as a debugger on 9229 |

### checkoutGuard

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns checkout-guard on or off |

### basics

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns all three rules on or off |
| `protectedBranches` | list of branch names | `["main", "master"]` | Branches the force-push rule protects |
| `rmRoot` | boolean | `true` | `rm -rf` and its PowerShell and cmd forms at a root, the home directory, or a folder above the repository |
| `forcePushMain` | boolean | `true` | `git push --force` to a protected branch. `--force-with-lease` always passes |
| `discardChanges` | boolean | `true` | `git reset --hard` or `git clean -fd` that would lose uncommitted work |

### orphanReaper

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns orphan-reaper on or off |
| `onSessionEnd` | boolean | `true` | Also reap right after a session exits. `false` leaves only the pass when a session starts |
| `extraNames` | list of program names | `[]` | More programs to stop once the session that started them has exited, such as `["my-server"]`. Matched without `.exe`, ignoring case |
| `keepNames` | list of program names | `[]` | Programs never to stop, nor anything they started, such as `["mongod"]` |

The built-in rules and keep list are in [guards/orphan-reaper.md](guards/orphan-reaper.md#what-it-stops).

### log

| Key | Type | Default | Environment | Meaning |
|---|---|---|---|---|
| `enabled` | boolean | `true` | `BULKHEAD_NO_LOG=1` turns it off | Writes each block to `events.jsonl` for `bulkhead log` |

### remote and remotes

Global file only. A project's `.claude/bulkhead.json` that sets either of these is ignored with a warning, because a repository you clone must not be able to make you connect to a machine or pass ssh options. Edit them with `bulkhead remote add` and `bulkhead remote remove`, or by hand.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `remote.default` | remote name | none | The remote `bulkhead remote run` uses when several are configured and `--remote` is not given |
| `remotes` | object | `{}` | One entry per machine, by name (letters, digits, `.`, `_`, `-`) |

Each entry in `remotes`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `host` | string | required | `user@host`, or a host alias from `~/.ssh/config`. May not start with `-` |
| `shell` | string | `"bash"` | The program that runs bulkhead's script there, fed on stdin with `-s`. A Windows remote with Git Bash: `"C:\Program Files\Git\bin\bash.exe"` |
| `dir` | string | `"~/bulkhead-remote"` | Folder for the copies, locks and port blocks. On Windows, `"C:/bulkhead-remote"` |
| `copies` | whole number, 1 to 8 | `4` | Copies of each project, so at most this many jobs of one project at once |
| `maxJobs` | whole number, 1 to 64 | `4` | Jobs at once on that machine, across all projects |
| `minFreeGb` | number | `0` | Free RAM to keep there. A job waits while its `--gb` would take free RAM below this |
| `sshOptions` | list of strings | `[]` | `ssh -o` options, each `Key=value`: `"IdentityFile=~/.ssh/buildbox"`, `"Port=2222"`, `"HostKeyAlias=buildbox"` |

```json
{
  "remotes": {
    "buildbox": { "host": "dev@192.168.1.20", "sshOptions": ["IdentityFile=~/.ssh/buildbox"], "minFreeGb": 2 },
    "winbox": { "host": "dev@192.168.1.30", "shell": "C:\Program Files\Git\bin\bash.exe", "dir": "C:/bulkhead-remote" }
  },
  "remote": { "default": "buildbox" }
}
```

An entry with a problem (a missing `host`, an unknown key, a value of the wrong type) is dropped as a whole with a warning, so a typo never means connecting with the wrong key. See [remote.md](remote.md).

## Environment variables

| Variable | Same as |
|---|---|
| `BULKHEAD_DISABLE` | Comma-separated names to turn off: `kill-guard`, `wait-guard`, `memory-guard`, `port-guard`, `checkout-guard`, `basics`, `orphan-reaper`, the basics rules `rm-root`, `force-push-main`, `discard-changes`, or `all`. A name listed here is off whatever the files say |
| `BULKHEAD_WAIT_MAX_SEC` | `waitGuard.limitSeconds` |
| `BULKHEAD_MIN_FREE_GB` | `memory.minFreeGb` |
| `BULKHEAD_SLOT_FLOOR_GB` | `memory.slotFloorGb` |
| `BULKHEAD_MAX_COMMIT_PCT` | `memory.maxCommitPct` |
| `BULKHEAD_NO_LOG` | `log.enabled: false` when set to `1`, `true` or `yes` |
| `BULKHEAD_STATE_DIR` | Where slots, the event log, `guards.log`, `remote-logs/` and the global config file live. Default `~/.claude/bulkhead` |
| `BULKHEAD_SSH` | The command `bulkhead remote` runs instead of `ssh`, as a JSON array such as `["ssh", "-F", "/path/to/config"]`. The tests point it at `test/fake-ssh.js` |

## Examples

A project that encodes video and kills its own stuck ffmpeg runs by name, and deploys from a `release` branch:

```json
{
  "killGuard": { "allowNames": ["ffmpeg"] },
  "basics": { "protectedBranches": ["main", "release"] }
}
```

A machine with 64 GB that should keep more headroom before a second heavy job:

```json
{
  "memory": { "minFreeGb": 6, "slotFloorGb": 12 }
}
```

A project whose integration tests legitimately wait up to five minutes in the foreground:

```json
{
  "waitGuard": { "limitSeconds": 300 }
}
```
