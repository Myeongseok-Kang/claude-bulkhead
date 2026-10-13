---
description: Run a heavy command (tests, a build, a browser run) on the configured remote machine instead of this one
argument-hint: "<command>, or empty for the remote status"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" remote status)
---

The remotes bulkhead knows about and what runs on them now:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" remote status 2>&1 || true`

The user's request: `$ARGUMENTS`

- If the request is empty, summarize the status above in a few lines: which remotes are reachable, their free RAM, and which jobs and copies they hold. If no remote is configured, explain that one is added with `bulkhead remote add <name> <user@host> --ssh-option=IdentityFile=<key>` and point to docs/remote.md in the plugin.
- Otherwise run it on the remote with the Bash tool, in the background (`run_in_background: true`), from this project's folder:

  ```
  node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" remote run --tail=60 -- '<the command>'
  ```

  Add `--gb=N` with the job's peak RAM when it is heavy (about 4 for a browser suite or a full build). A server the command starts must listen on `$BULKHEAD_PORT`. End your turn and report when it finishes: the exit code, the summary and failures from the last lines, and the log path for the rest. Exit 3 means the remote had no free copy or RAM in time, 4 a transfer or setup problem, 5 an unreachable remote; the `[bulkhead remote]` lines say which.
