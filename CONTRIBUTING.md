# Contributing

Thanks for helping. The most useful contributions are false-positive reports with the exact command, and fixes that come with a test.

## Setup

Node 18 or later. There are no dependencies to install.

```
git clone https://github.com/Myeongseok-Kang/claude-bulkhead
cd claude-bulkhead
node --test
```

CI runs the same command on Linux, macOS and Windows with Node 18 and 22. Run it on every platform you can; process reading, paths and shells differ on each.

To try the plugin in Claude Code from your checkout:

```
claude --plugin-dir .
claude plugin validate . --strict
```

## Layout

| Path | What is there |
|---|---|
| `src/<guard>.js` | One hook per file. Each exports a pure `check()` (or `judge()`, `classify()`) that tests call directly, and runs as a hook only under `require.main === module` |
| `src/hook.js` | Reads the hook payload, applies `BULKHEAD_DISABLE` and the config files, and records blocks with `blocked()` |
| `src/config.js` | Every setting, its type, default and environment variable |
| `src/events.js` | The event log |
| `src/processes.js`, `src/sessions.js` | Process snapshots per platform, and which process belongs to which Claude session |
| `src/*-cli.js`, `src/top.js`, `src/doctor.js`, `src/status.js` | The `bulkhead` subcommands |
| `src/remote.js`, `src/remote-sh.js`, `src/remotes.js` | `bulkhead remote`: this side, the bash scripts it sends to the remote, and the remote config. `test/remote.test.js` runs the remote side locally through `test/fake-ssh.js`; `scripts/remote-e2e.sh` runs it over real ssh |
| `hooks/hooks.json` | Which scripts run on which hook events |
| `commands/`, `skills/` | Slash commands and the skill |
| `test/` | `node:test` files, one per module |

## Adding a must-pass case for a false positive

A false positive is a command a guard blocks that it should let through. Fix it with a test first:

1. Find the guard's cases: the `blocked` and `allowed` arrays in `test/kill-guard.test.js`, the `cases` table in `test/wait-guard.test.js` (`[command, tool timeout, should block]`), the `cases` table in `test/dev-servers.test.js` for port detection, the `killPorts` cases in `test/port-guard.test.js`, and the assertions in `test/basics.test.js`, `test/memory-guard.test.js` and `test/checkout-guard.test.js`.
2. Add the reported command exactly as it was run, in the allowed list or with `false`. Keep the user's quoting and line breaks.
3. Run `node --test test/<guard>.test.js` and watch it fail.
4. Fix the guard as narrowly as you can. Prefer recognizing the safe shape (a PID, a path, a quoted string, a heredoc written to a file) over removing a pattern.
5. Check that every existing blocked case still blocks. A fix that lets a name-based kill through is worse than the false positive.
6. If the command is legitimate only in some projects, it may belong in a config key instead (`killGuard.allowNames`, `portGuard.ignorePorts`, `waitGuard.limitSeconds`). Say so in the pull request.

A missed block (a false negative) works the same way, with the command added to the blocked list.

## Performance

PreToolUse guards run on every Bash and PowerShell call, so each one must stay close to Node's own startup time. Measure before and after a change to a guard:

```
node scripts/bench-hooks.js 15
```

It prints the median per guard for an allowed command and for a blocked one, with and without the event log. Anything slow (a process scan, a git call, a network probe) must only run after a cheap text match says it is needed.

## Rules for guards

- Fail open. Any error, unreadable input, unknown platform or ambiguous owner lets the call through. A guard that blocks by mistake gets turned off, and then it protects nothing.
- Block only what can hurt another session or lose work. Not style, not preferences.
- The block message tells Claude what to do instead, with a concrete command, and names the other session when there is one.
- Never kill, write or delete anything from a PreToolUse hook. orphan-reaper is the only part that stops processes, and only by PID.
- Record each block with `blocked(name, rule, input, message)` from `src/hook.js`, and add the rule name to `docs/commands.md`.
- New settings go in `src/config.js`, `config.example.json` and `docs/configuration.md` together; a test checks that the example covers every key.

## Commits and pull requests

- One logical change per commit. The subject says what changed in plain words, under about 72 characters, for example `port-guard: block kills by port aimed at another session's server`.
- Prefix with the guard or command when the change is limited to one.
- Update `CHANGELOG.md` under `Unreleased` for anything a user would notice.
- Do not add dependencies. The plugin runs with Node's standard library only.
- Keep machine-specific details out of the tree: no personal paths, host names or project names in code, tests or docs. Use placeholders like `~/src/acme-web` and `~/src/acme-web-checkout`.
