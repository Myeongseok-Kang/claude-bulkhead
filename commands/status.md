---
description: Show the Claude Code sessions on this machine, their ports and memory, heavy jobs and free RAM
allowed-tools: Bash(node:*)
---

Output of `bulkhead status`:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" status`

Summarize this for the user in a few lines:

- How many sessions are running, and which project uses the most memory.
- Which ports are taken and by which project, so a new dev server can avoid them.
- Heavy jobs running or waiting in bulkhead-slot, if any.
- Free RAM. If it is below the memory-guard minimum, say that heavy commands will be blocked until memory frees up.

Do not stop or restart anything. If the user wants a free port, run `bulkhead port --near <port>`.
