#!/usr/bin/env bash
# End-to-end test of `bulkhead remote` over a real ssh connection.
#
# In CI (CI=true, Linux) it starts an sshd on 127.0.0.1:2222 with a fresh key, which needs sudo
# and adds the key to ~/.ssh/authorized_keys. To test against a machine you already reach, set
#   E2E_HOST=dev@192.168.1.20 E2E_DIR=/tmp/bulkhead-e2e [E2E_SHELL=bash] [E2E_SSH_OPTIONS=Key=value,...]
# E2E_DIR is created on the remote and is yours to delete afterwards.
# Run from the repository root: bash scripts/remote-e2e.sh
set -euo pipefail

ROOT=$(pwd)
TMP=$(mktemp -d)
SSHD_PID=""
cleanup() {
  # by PID only: other sshd processes on the machine are not ours
  if [ -n "$SSHD_PID" ]; then sudo kill "$SSHD_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "FAILED: $*" >&2; exit 1; }
bh() { node "$ROOT/bin/bulkhead" "$@"; }

export BULKHEAD_STATE_DIR="$TMP/state" BULKHEAD_REMOTE_POLL=1 BULKHEAD_DISABLE=""
OPTS=()
if [ -z "${E2E_HOST:-}" ]; then
  # this changes ~/.ssh/authorized_keys and starts a root sshd: only on a throwaway CI machine
  if [ "${CI:-}" != true ] || [ "$(uname -s)" != Linux ]; then
    echo "Set E2E_HOST (see the top of this script). A local sshd is only started in CI on Linux." >&2
    exit 2
  fi
  ssh-keygen -q -t ed25519 -N '' -f "$TMP/id"
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  cat "$TMP/id.pub" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
  [ -x /usr/sbin/sshd ] || sudo apt-get install -y -q openssh-server >/dev/null
  sudo mkdir -p /run/sshd
  sudo ssh-keygen -A >/dev/null
  sudo /usr/sbin/sshd -p 2222 -o ListenAddress=127.0.0.1 -o PasswordAuthentication=no -o PidFile="$TMP/sshd.pid"
  for _ in $(seq 1 40); do [ -s "$TMP/sshd.pid" ] && break; sleep 0.25; done
  SSHD_PID=$(cat "$TMP/sshd.pid")
  ssh-keyscan -p 2222 127.0.0.1 > "$TMP/known_hosts" 2>/dev/null
  E2E_HOST="$(whoami)@127.0.0.1"
  E2E_DIR="$TMP/remote dir"
  OPTS=(--ssh-option=Port=2222 "--ssh-option=IdentityFile=$TMP/id" "--ssh-option=UserKnownHostsFile=$TMP/known_hosts")
else
  IFS=',' read -r -a extra <<< "${E2E_SSH_OPTIONS:-}"
  for o in "${extra[@]}"; do [ -n "$o" ] && OPTS+=("--ssh-option=$o"); done
fi

bh remote add e2e "$E2E_HOST" "--shell=${E2E_SHELL:-bash}" "--dir=$E2E_DIR" --copies=2 "${OPTS[@]}"
bh doctor --json | node -e "
  const c = JSON.parse(require('fs').readFileSync(0, 'utf8')).checks.find(x => x.id === 'remote e2e')
  console.log(c.status, c.summary)
  if (c.status !== 'OK') process.exit(1)" || fail "doctor"

REPO="$TMP/my app"
mkdir -p "$REPO"
cd "$REPO"
git init -q
git config user.email e2e@example.com
git config user.name e2e
printf 'node_modules\nout\n' > .gitignore
echo one > a.txt
echo bye > gone.txt
git add -A
git commit -qm first

run() { set +e; OUT=$(bh remote run "$@" 2>&1); RC=$?; set -e; echo "$OUT"; }
expect() { grep -q -- "$1" <<< "$OUT" || fail "expected '$1' in the output above"; }

echo "== first run: full history, exit code passes through"
run -- 'cat a.txt; echo "port=$BULKHEAD_PORT copy=$BULKHEAD_COPY"; exit 7'
[ "$RC" = 7 ] || fail "exit code $RC, expected 7"
expect 'full history'
expect 'copy=a'
PORT=$(sed -n 's/.* port \([0-9]*\)$/\1/p' <<< "$OUT" | head -n 1)

echo "== second run: nothing to send"
run -- true
[ "$RC" = 0 ] || fail "exit code $RC"
expect 'already there, no uncommitted changes'

echo "== a new commit goes as an incremental bundle; changes and deletions arrive"
echo two > a.txt
git commit -qam second
echo three > a.txt
rm gone.txt
echo new > 'new file.txt'
run -- 'cat a.txt "new file.txt"; test -e gone.txt && echo STILL_THERE; git log --oneline | wc -l'
[ "$RC" = 0 ] || fail "exit code $RC"
expect 'new commits'
expect '1 deleted'
expect three
expect new
grep -q STILL_THERE <<< "$OUT" && fail "a deleted file is still on the remote"

echo "== a server left on BULKHEAD_PORT is stopped"
cat > serve.js <<'EOF'
require('child_process').spawn(process.execPath, ['-e', 'require("net").createServer().listen(Number(process.env.BULKHEAD_PORT))'], { detached: true, stdio: 'ignore' }).unref()
EOF
run -- 'node serve.js; sleep 2'
expect 'still listening on BULKHEAD_PORT'
run -- "node -e \"require('net').connect($PORT, '127.0.0.1').on('connect', () => { console.log('PORT_OPEN'); process.exit() }).on('error', () => console.log('PORT_CLOSED'))\""
expect PORT_CLOSED

echo "== two runs at once use two copies"
bh remote run -- 'echo "copy=$BULKHEAD_COPY"; sleep 3' > "$TMP/p1" 2>&1 &
P1=$!
sleep 1
run -- 'echo "copy=$BULKHEAD_COPY"'
wait "$P1"
cat "$TMP/p1"
expect 'copy=b'
grep -q 'copy=a' "$TMP/p1" || fail "the first run did not get copy a"

echo "== --tail, --fetch and fetch"
run --tail=2 --fetch=out -- 'i=0; while [ $i -lt 50 ]; do i=$((i + 1)); echo "line $i"; done; mkdir -p out; echo result > out/r.txt'
expect 'line 50'
grep -q 'line 10$' <<< "$OUT" && fail "--tail printed more than the tail"
[ "$(cat out/r.txt)" = result ] || fail "--fetch did not bring out/r.txt"
rm -rf out
bh remote fetch out got
[ "$(cat got/out/r.txt)" = result ] || fail "fetch did not bring out/r.txt"

echo "== a lost connection stops the job and frees the copy"
# node itself in the background (not the bh function), so $! is the process to kill
node "$ROOT/bin/bulkhead" remote run -- 'mkdir -p out; node -e "require(\"fs\").writeFileSync(\"out/job.pid\", String(process.pid)); console.log(\"started\"); setInterval(() => {}, 1000)"' > "$TMP/d" 2>&1 &
P=$!
for _ in $(seq 1 120); do grep -q started "$TMP/d" && break; sleep 0.5; done
grep -q started "$TMP/d" || { cat "$TMP/d"; fail "the long job did not start"; }
kill -9 "$P"
freed=""
for _ in $(seq 1 30); do
  if bh remote status --json | node -e "process.exit(JSON.parse(require('fs').readFileSync(0, 'utf8')).remotes[0].locks.length ? 1 : 0)"; then freed=1; break; fi
  sleep 1
done
[ -n "$freed" ] || fail "the locks were not freed after the connection was lost"
run --wait=0 -- "node -e \"try { process.kill(Number(require('fs').readFileSync('out/job.pid', 'utf8')), 0); console.log('JOB_ALIVE') } catch { console.log('JOB_GONE') }\""
expect 'copy a'
expect JOB_GONE

echo "== unreachable exits 5"
bh remote add down nobody@127.0.0.1 --ssh-option=Port=1 --no-check
set +e; bh remote run --remote=down -- true; RC=$?; set -e
[ "$RC" = 5 ] || fail "exit code $RC for an unreachable remote, expected 5"

echo "remote e2e: all checks passed"
