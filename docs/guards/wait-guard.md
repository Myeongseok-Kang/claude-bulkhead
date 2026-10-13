# wait-guard

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Blocks a foreground command when its sleeps can add up to more than 180 seconds.

## Why

The prompt cache expires after about five minutes without a request. A subagent that polls with `for i in $(seq 1 19); do grep -q DONE out || sleep 30; done` comes back to a cold cache every time and writes the whole context again. Each rewrite is billed as a cache write instead of a cheaper cache read.

## How it estimates

It multiplies the loop count by the sleep length, treats `until` and `while` as unbounded, and caps the estimate at the tool timeout (120 seconds unless the call raises it).

## Blocked

These are blocked when the call raises the tool timeout above 180 seconds, for example `timeout: 600000`. With the default 120 second timeout, the tool timeout is the cap and they pass.

```
for i in $(seq 1 19); do grep -q DONE out || sleep 30; done     # about 570 s
until [ -f out/DONE ]; do sleep 15; done                         # unbounded, capped at the timeout
sleep 300
Start-Sleep -Seconds 240
bash -c "sleep 300"                                              # wrappers are opened, as in kill-guard
python -c "import time; time.sleep(300)"                         # also node -e, deno eval, ruby -e, perl -e, php -r
node -e "setTimeout(() => {}, 300000)"
timeout /t 300 /nobreak
ping -n 301 127.0.0.1                                            # about 300 s; ping -t and posix ping without -c never end
tail -f server.log                                               # also docker logs -f, kubectl logs -f, journalctl -f, Get-Content -Wait
[Threading.Thread]::Sleep(300000)
```

## Allowed

```
sleep 5 && curl -s localhost:3000                 # short wait for a server
for i in 1 2 3; do sleep 10; done                 # 30 s
until [ -f out/DONE ]; do sleep 15; done          # with run_in_background: true
cat > poll.sh <<'EOF' ... EOF                     # a heredoc that only writes a script
echo "sleep 600"                                  # sleep only in echo, grep or git text
git commit -m "drop the sleep 900 poll"           # commit and pull request text is never run
docker exec -d web sleep 600                      # detached
Start-Job { Start-Sleep 600 }                     # a PowerShell background job
```

Commands with `run_in_background: true` always pass. So do sleeps in a background job, because the tool call returns without waiting for it:

```
sleep 600 &
(sleep 600; touch done) &
nohup sleep 900 > /dev/null 2>&1 &
npm run dev > log 2>&1 & sleep 5
```

A later `wait` brings the job back into the foreground, so `sleep 600 & wait` is still blocked. `2>&1`, `&>` and `&&` do not count as background.

## What Claude sees

```
[bulkhead] wait-guard: this command can sit in the foreground for about 570s (limit 180s).
A foreground wait holds the session: it cannot answer the user or do anything else until the command returns. The prompt cache also expires after about 5 minutes without a request, so the request after a long wait writes the whole context to the cache again instead of reading it.
Run the same loop with run_in_background: true and end your turn; you are notified once when it exits. For example:
  until [ -f out/DONE ]; do sleep 15; done; tail -20 out/log.txt
For a one-off check, skip the sleep and read the output file now.
```

## Turn off or tune

- `BULKHEAD_DISABLE=wait-guard` turns it off.
- `BULKHEAD_WAIT_MAX_SEC`, or `waitGuard.limitSeconds` in a config file, raises or lowers the 180 second limit.
- `"waitGuard": { "enabled": false }` in a config file turns it off for one project or the machine.

## Limits

- It cannot know how long a loop that waits on a condition will run, so it assumes the worst and relies on the tool timeout as the cap.
- A sleep inside a script file is not seen. Inline code (`python -c`, `node -e`) is read for its sleep and timer calls, not run.
