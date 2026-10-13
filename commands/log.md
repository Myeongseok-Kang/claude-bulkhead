---
description: Summarize what the bulkhead guards blocked, optionally for a period such as 24h or 7d
argument-hint: "[24h|7d|30d]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" log:*)
---

Blocks recorded by bulkhead, for the period `$ARGUMENTS` (all time when empty):

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" log --summary --since="$ARGUMENTS" 2>&1 || true`

Latest events:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" log -n 10 --since="$ARGUMENTS" 2>&1 || true`

Summarize for the user:

- Which guards and rules fired most, and in which projects.
- Any pattern worth acting on, for example the same command blocked again and again in one project. When a block looks like a false positive, name the config key that would allow it (see `bulkhead config`), such as `killGuard.allowNames` or `portGuard.ignorePorts`, and suggest putting it in that project's `.claude/bulkhead.json` rather than turning the guard off.

If nothing was recorded, say so in one line.
