# Privacy

bulkhead collects no data and sends nothing to its author or to any other service. There is no telemetry, no analytics and no update check.

## What it reads

To find the other Claude Code sessions and what they started, bulkhead reads the process list and the session records Claude Code keeps on your machine. It reads them on your machine and does not copy them anywhere.

## What it stores

bulkhead writes to its state directory, `~/.claude/bulkhead` by default (`BULKHEAD_STATE_DIR` changes it):

- `config.json`, your settings.
- Slot reservations for `bulkhead-slot`.
- `events.jsonl` and `guards.log`: each blocked command and each process orphan-reaper stopped. `BULKHEAD_NO_LOG=1` turns off `events.jsonl`.
- `remote-logs/`: the full output of `bulkhead remote run --tail`.

Deleting the directory removes all of it. `bulkhead remote` also saves a short ID for each repository it sends in that repository's `.git/config` (`bulkhead.remoteid`), and keeps up to 8 copies of the repository on the remote machine in the directory set for that remote (`~/bulkhead-remote` by default).

## Network

- port-guard connects to a port on `localhost` to see whether it answers.
- `bulkhead remote` connects over SSH to a machine you added with `bulkhead remote add`, and only when you run it. It sends that machine the current commit and the uncommitted changes of the repository you run it from, and runs your command there. It uses your own SSH setup and keys and stores no credentials.

Nothing else opens a network connection.

## Questions

Open an issue at https://github.com/Myeongseok-Kang/claude-bulkhead/issues.
