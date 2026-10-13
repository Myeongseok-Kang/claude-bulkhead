---
description: Check the bulkhead install, settings and this machine's limits
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" doctor)
---

Output of `bulkhead doctor`:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" doctor 2>&1 || true`

Report to the user:

1. Every FAIL line first, with what it breaks and how to fix it.
2. Then every WARN line, the same way.
3. Then one line saying which guards are on and which are off.

If everything is OK, say so in one line and give the RAM limits computed for this machine.
Do not change any settings or files yourself.
