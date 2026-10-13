---
description: List the processes that Claude Code sessions which have exited left running, and why orphan-reaper would stop them
allowed-tools: Bash(node:*)
---

Dry run of `bulkhead reap`, which stops nothing:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" reap --dry-run`

Summarize for the user:

- How many process trees would be stopped, grouped by rule (test-runner, watcher, builder, headless-browser, dev-server), and which projects they come from when the command lines show it.
- Anything in the list the user may want to keep. Name the setting that would protect it: `orphanReaper.keepNames` in `~/.claude/bulkhead/config.json` or the project's `.claude/bulkhead.json`.

Do not stop anything yourself. If the user asks to stop them, run `bulkhead reap` and report what it stopped. If nothing was listed, say so in one line.
