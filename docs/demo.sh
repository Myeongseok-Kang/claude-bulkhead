#!/usr/bin/env bash
# Script behind docs/demo.svg. Linux only. Record with:
#   asciinema rec --cols 110 --rows 32 -c 'bash docs/demo.sh' demo.cast
#   npx svg-term-cli@2.1.1 --in demo.cast --out docs/demo.svg --window
#
# There is no second Claude Code session on a recording machine, so two stand-ins are started:
# processes named `claude` with the session files Claude Code writes. Everything printed below
# comes from the real hook scripts and the real `bulkhead status`.
set -eu
cd "$(dirname "$0")/.."
root=$PWD
work=$(mktemp -d)
export CLAUDE_CONFIG_DIR=$work/claude BULKHEAD_STATE_DIR=$work/state PATH=$root/bin:$PATH
mkdir -p "$CLAUDE_CONFIG_DIR/sessions" "$work/bin" ~/demo/shop ~/demo/blog
cp "$(command -v sleep)" "$work/bin/claude"
pids=()
trap 'kill "${pids[@]}" 2>/dev/null; rm -rf "$work"' EXIT

session() {
  "$work/bin/claude" 600 &
  pids+=($!)
  printf '{"pid":%d,"sessionId":"s%d","cwd":"%s","startedAt":%d}\n' $! $! "$1" "$(date +%s%3N)" > "$CLAUDE_CONFIG_DIR/sessions/$!.json"
}

say() { printf '\n\033[2m# %s\033[0m\n' "$*"; sleep 1.2; }
run() { printf '\033[1m$ %s\033[0m\n' "$*"; sleep 0.6; "$@" || true; sleep 2.2; }

# what Claude Code sends a PreToolUse hook
hook() {
  printf '\033[1mclaude wants to run:\033[0m %s\n' "$2"
  sleep 0.6
  local input
  input=$(node -e 'console.log(JSON.stringify({ tool_name: "Bash", cwd: process.argv[1], tool_input: { command: process.argv[2], timeout: 600000 } }))' "$PWD" "$2")
  if printf '%s' "$input" | node "$root/src/$1.js"; then echo "-> allowed"; else echo "-> blocked, exit $?"; fi
  sleep 2.6
}

session ~/demo/shop
shop=$!
session ~/demo/blog
CLAUDE_PID=$shop node -e "require('http').createServer((q, s) => s.end('shop')).listen(3000)" &
pids+=($!)
bulkhead-slot run --gb=2 --label="npx playwright test" -- sleep 60 2>/dev/null &
pids+=($!)
export CLAUDE_PID=${pids[1]}
sleep 1.5
cd ~/demo/blog

say "Two Claude Code sessions on one machine. The shop session runs a dev server on 3000."
run bulkhead status

say "The blog session wants its own dev server, also on the default port."
hook port-guard "npx next dev"

say "It decides to clear the port by name instead."
hook kill-guard "taskkill /F /IM node.exe"

say "Then it waits for a build in the foreground for up to 10 minutes."
hook wait-guard 'for i in $(seq 1 20); do grep -q DONE build.log && break; sleep 30; done'

say "Stopping its own process by PID passes."
hook kill-guard "taskkill /PID 4312 /T /F"
