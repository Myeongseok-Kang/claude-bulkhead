# Instructions for AI agents working on this repository

claude-bulkhead is a Claude Code plugin: hooks and a small CLI that keep parallel Claude Code sessions and subagents on one machine from killing each other's processes, taking each other's ports, running out of RAM together, or moving each other's git tree. Node 18+, standard library only.

## Before you change anything

- Read `CONTRIBUTING.md`. The rules for guards there are requirements, not suggestions: fail open, block only what hurts another session or loses work, tell Claude what to do instead.
- Run `node --test` first, so you know the baseline. It takes a few seconds and needs no install.
- This machine may be running other Claude sessions while you work. The plugin's own guards apply to you: do not kill processes by name, do not stop servers on ports you did not start, do not `git checkout` or `git stash` in a checkout another session uses. Work in a git worktree.

## Making a change

- Every behavior change comes with a test in `test/<module>.test.js`, in the existing `node:test` style. For a false positive or a missed block, add the exact command to the guard's case table first and watch it fail.
- Keep each guard's decision in a pure function (`check`, `judge`, `classify`, `killPorts`) that takes everything it needs as arguments, so tests do not depend on the machine. Inject process snapshots, session files, probes and clocks.
- Hooks must stay fast. Run `node scripts/bench-hooks.js 15` before and after touching a PreToolUse guard; the median should stay within a few milliseconds of Node's own startup. Do expensive work (process scans, git, sockets) only after a cheap text match.
- Never add a runtime dependency.
- A new setting goes into `src/config.js` (with type, default and, if any, environment variable), `config.example.json` and `docs/configuration.md` in the same change.
- A new block rule gets a rule name passed to `blocked()` and a row in the rules table in `docs/commands.md`.
- After changing `hooks/hooks.json`, `.claude-plugin/`, `commands/` or `skills/`, run `claude plugin validate . --strict`.

## Do not

- Do not add machine-specific details to the tree: personal paths, host names, user names, company or project names. Examples use one repository in three worktrees: `~/src/acme-web`, `~/src/acme-web-auth`, `~/src/acme-web-checkout`.
- Do not make a guard stop, write or delete anything. Guards only allow or block. orphan-reaper is the only code that stops processes, and only by PID after proving the owner session is gone.
- Do not loosen a test's expected block to make a change pass. If a blocked case must change, explain why in the commit message.
- Do not rewrite README sections unrelated to your change.

## Checking your work

```
node --test
claude plugin validate . --strict
node bin/bulkhead doctor
```

Report the test counts and, for guard changes, the before and after numbers from `scripts/bench-hooks.js`.
