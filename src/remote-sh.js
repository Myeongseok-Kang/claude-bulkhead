'use strict'
// The bash scripts bulkhead remote runs on the other machine. Each one is sent on ssh's stdin to
// `<shell> -s`, so the remote needs only bash, git and tar, and it works whatever the login shell
// is (bash, zsh or Windows cmd). Values go in single-quoted, and every script is built in memory:
// a script read from disk while another process edits it once ran half old, half new.

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`

// Ports: 100 blocks of 8 from 7100. 5000 (macOS AirPlay) and 5060/5061 (refused by browsers)
// are below the range. A project keeps its block in <dir>/ports/<n>, so two projects never share one.
const PORT_BASE = 7100
const PORT_BLOCKS = 100
const LETTERS = 'abcdefgh'

// FNV-1a. Only a starting point for the block search on the remote, so any stable hash will do.
function hash(s) {
  let h = 0x811c9dc5
  for (const b of Buffer.from(String(s))) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h
}

// The whole script is one { } group. bash reads a script from a pipe as it goes, so without the
// group a later `read` (the disconnect watcher) would consume the rest of the script as input.
const group = body => `{\n${body}}\n`

// Shared by every script: where the remote dir is, how to talk back, and the helpers.
// Lines for bulkhead go out as `@@bulkhead-<token> key value`, so nothing a job or a login
// script prints can be mistaken for them.
function prelude({ token, dir, markFd = 2 }) {
  return `set -u
T=${q(token)}
D=${q(dir)}
MARKFD=${markFd}
mark() { printf '@@bulkhead-%s %s\\n' "$T" "$*" >&"$MARKFD"; }
WIN=0
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) WIN=1 ;; esac
case "$D" in '~') D=$HOME ;; '~/'*) D=$HOME/\${D#'~/'} ;; esac
# Git Bash: C:/x and C:\\x become /c/x. GNU tar reads "C:" in a file name as a remote host.
if [ "$WIN" = 1 ]; then case "$D" in [A-Za-z]:*) D=$(cygpath -u "$D") ;; esac; fi
native() { if [ "$WIN" = 1 ]; then cygpath -m "$1"; else printf '%s\\n' "$1"; fi; }
now() { date +%s; }
gb() { awk -v m="$1" 'BEGIN { printf "%.1f", m / 1024 }'; }
alive() { kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1; }
# macOS prints "{ sec = 1700000000, usec = 52000 } Tue Nov 14 ...", and "usec = " ends in "sec = " too
kern_boottime() { sed -n 's/^[^{]*{ *sec = \\([0-9][0-9]*\\).*$/\\1/p'; }
boot_time() {
  b=$(awk '/^btime/ { print $2 }' /proc/stat 2>/dev/null)
  [ -z "$b" ] && b=$(sysctl -n kern.boottime 2>/dev/null | kern_boottime)
  [ -z "$b" ] && [ -r /proc/uptime ] && b=$(( $(now) - $(cut -d. -f1 /proc/uptime) ))
  printf '%s\\n' "\${b:-0}"
}
# "free total" in MB. Git Bash has /proc/meminfo too; its MemFree is Windows' available memory.
mem_mb() {
  if [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } /^MemFree:/ { f = $2 }
      END { if (a == "") a = f; if (t) printf "%d %d\\n", a / 1024, t / 1024 }' /proc/meminfo
  elif command -v vm_stat >/dev/null 2>&1; then
    vm_stat | awk -v ps="$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)" -v tot="$(sysctl -n hw.memsize 2>/dev/null || echo 0)" '
      /^Pages free/ { f = $3 + 0 } /^Pages inactive/ { i = $3 + 0 } /^Pages speculative/ { s = $3 + 0 } /^Pages purgeable/ { p = $3 + 0 }
      END { printf "%d %d\\n", (f + i + s + p) * ps / 1048576, tot / 1048576 }'
  elif [ "$WIN" = 1 ]; then
    powershell -NoProfile -Command '$o = Get-CimInstance Win32_OperatingSystem; "$([int]($o.FreePhysicalMemory / 1024)) $([int]($o.TotalVisibleMemorySize / 1024))"' 2>/dev/null | tr -d '\\r'
  fi
}
lock_info() { sed -n "s/^$2=//p" "$1/info" 2>/dev/null | head -n 1; }
lock_started() {
  local s
  s=$(lock_info "$1" started)
  [ -z "$s" ] && s=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || now)
  printf '%s\\n' "$s"
}
# Seconds since the holder last wrote its heartbeat (once a minute while the job runs).
lock_quiet() {
  local b
  b=$(cat "$1/beat" 2>/dev/null)
  [ -z "$b" ] && b=$(lock_started "$1")
  echo $(( $(now) - b ))
}
# A held lock: not one being removed (.stale.<pid>) or a reclaim mutex (.reclaim).
is_lock() { [ -d "$1" ] && case "$1" in *.stale.*|*.reclaim) return 1 ;; esac; }
# Prints why a lock is stale and returns 0, or returns 1 while its holder may still be running.
lock_stale() {
  local p
  p=$(lock_info "$1" pid)
  if [ -n "$p" ] && ! alive "$p"; then echo "its process $p is gone"; return 0; fi
  [ "$BOOT" -gt 0 ] && [ "$(lock_started "$1")" -lt "$BOOT" ] && { echo "it was taken before the last reboot"; return 0; }
  [ "$(lock_quiet "$1")" -gt 21600 ] && { echo "no sign of life for 6 hours"; return 0; }
  return 1
}
BOOT=$(boot_time)
`
}

// Answers whether the remote is usable and which commits copy a already has.
function probeScript({ token, dir, project, sha }) {
  return group(prelude({ token, dir, markFd: 1 }) + `P=${q(project)}
SHA=${q(sha || '')}
A="$D/$P"
mark ok
mark platform "$(uname -s 2>/dev/null)"
mark bash "$BASH_VERSION"
# macOS without the command line tools has a /usr/bin/git that only offers to install them
v=$(git --version 2>/dev/null) && [ -n "$v" ] && mark git "$v" || mark git none
if command -v tar >/dev/null 2>&1; then mark tar yes; else mark tar none; fi
mark dir "$(native "$D")"
if mkdir -p "$D" 2>/dev/null && : > "$D/.probe-$$" 2>/dev/null; then rm -f "$D/.probe-$$"; mark writable yes; else mark writable no; fi
mark mem "$(mem_mb)"
if [ -n "$SHA" ] && [ -d "$A/.git" ]; then
  if git -C "$A" cat-file -e "$SHA^{commit}" 2>/dev/null; then mark head yes; else
    mark head no
    { git -C "$A" for-each-ref --format='%(objectname)' refs/bulkhead/ 2>/dev/null
      git -C "$A" worktree list --porcelain 2>/dev/null | sed -n 's/^HEAD //p'; } | sort -u | while read -r r; do mark ref "$r"; done
  fi
fi
`)
}

// Saves the upload (a tar of the bundle and the changed files) under <dir>/.incoming/<id>.
// tar reads the rest of stdin: bash reads its script one byte at a time from a pipe, so the
// bytes after the last line are left for the command on it.
function uploadScript({ token, dir, id }) {
  return group(prelude({ token, dir }) + `U="$D/.incoming/"${q(id)}
mkdir -p "$U" || exit 4
exec tar -xf - -C "$U"
`)
}

// Sends one path from a copy as a tar stream on stdout, after a marker line so that anything a
// login script prints first can be skipped.
function fetchScript({ token, dir, project, letter, sub, path }) {
  return group(prelude({ token, dir }) + `P=${q(project)}
L=${q(letter)}
R=${q(path)}
if [ "$L" = a ]; then C="$D/$P"; else C="$D/$P-$L"; fi
[ -d "$C" ] || { mark fail "copy $L of $P does not exist on this machine"; exit 4; }
cd "$C"/${q(sub || '.')} 2>/dev/null || { mark fail "no folder ${sub || '.'} in copy $L"; exit 4; }
[ -e "$R" ] || { mark fail "$R does not exist in copy $L ($(native "$PWD"))"; exit 1; }
printf '@@bulkhead-%s tar\n' "$T"
# "./" first, so a name starting with - is not read as an option
exec tar -cf - -C "$(dirname "./$R")" "./$(basename "./$R")"
`)
}

// One line per held lock and per copy, and free RAM.
function statusScript({ token, dir }) {
  return group(prelude({ token, dir, markFd: 1 }) + `mark ok
mark dir "$(native "$D")"
mark mem "$(mem_mb)"
for l in "$D"/jobs/job-* "$D"/lock-*; do
  is_lock "$l" || continue
  why=$(lock_stale "$l") || why=""
  mark lock "$(basename "$l")|$(( $(now) - $(lock_started "$l") ))|$(lock_info "$l" gb)|$(lock_info "$l" from)|$why|$(lock_info "$l" label)"
done
for c in "$D"/*; do [ -e "$c/.git" ] && mark copy "$(basename "$c")"; done
`)
}

// The job: take a job slot and a copy, bring the copy to the sent commit and changes, run the
// command with its own port, then stop whatever it left behind and free the locks.
function runScript(o) {
  const L = LETTERS.slice(0, o.copies).split('').join(' ')
  const lines = []
  for (const f of o.deleted || []) lines.push(`rm -f -- "$C"/${q(f)}`)
  for (const f of o.executable || []) lines.push(`chmod +x -- "$C"/${q(f)} 2>/dev/null`)
  return group(prelude({ token: o.token, dir: o.dir }) + `P=${q(o.project)}
SHA=${q(o.sha)}
U=${q(o.upload || '')}
HAS_BUNDLE=${o.bundle ? 1 : 0}
HAS_TAR=${o.tar ? 1 : 0}
SUB=${q(o.sub || '.')}
CMD=${q(o.command)}
LABEL=${q(String(o.label || '').replace(/[\r\n]+/g, ' '))}
FROM=${q(o.from || '')}
GBMB=${Math.round((o.gb || 0) * 1024)}
MINFREE=${Math.round((o.minFreeGb || 0) * 1024)}
MAXJOBS=${o.maxJobs}
WAIT=${Math.max(0, Math.round(o.waitSeconds))}
POLL=${Math.max(1, Math.round(o.pollSeconds || 30))}
HOLD=${o.hold ? 1 : 0}
PHASH=${hash(o.project) % PORT_BLOCKS}
LETTERS=${q(L)}
N=${o.copies}
A="$D/$P"
INC="$D/.incoming"
JOBLOCK=""; COPYLOCK=""; RECLAIM=""; HB=""; W=""; JOB=""; DONE=0; L=""; C=""; FETCHED=0
trap '' PIPE
# The ssh channel stays on fd 0 and is read there: once bash has parsed the { } group it does not
# read fd 0 again. No copy on another fd: bash 3.2 (macOS) gives \`exec 3<&0\` a stream record
# sharing fd 0's input buffer, and a child that redirects fd 0 and then closes or redirects fd 3
# frees that buffer twice. macOS's allocator aborts on it (the job died of SIGABRT, exit 134).

release() { [ -n "$1" ] && [ -d "$1" ] && [ "$(lock_info "$1" pid)" = "$$" ] && rm -rf "$1"; }
# One process at a time may judge a lock stale and remove it. Without the .reclaim mutex, two
# waiters could both judge the same dead lock, and the slower one would then move away the
# fresh lock the faster one had just taken. A mutex left by a killed process expires in 2 min.
take() {
  local why
  if [ -d "$1" ]; then
    [ -n "$(find "$1.reclaim" -maxdepth 0 -mmin +2 2>/dev/null)" ] && rmdir "$1.reclaim" 2>/dev/null
    if mkdir "$1.reclaim" 2>/dev/null; then
      RECLAIM="$1.reclaim"
      if why=$(lock_stale "$1") && mv "$1" "$1.stale.$$" 2>/dev/null; then
        rm -rf "$1.stale.$$"
        mark reclaimed "$(basename "$1"): $why"
      fi
      rmdir "$RECLAIM" 2>/dev/null
      RECLAIM=""
    fi
  fi
  mkdir "$1" 2>/dev/null || return 1
  printf 'pid=%s\\nstarted=%s\\ngb=%s\\nfrom=%s\\nlabel=%s\\n' "$$" "$(now)" "$GBMB" "$FROM" "$LABEL" > "$1/info"
}
take_job() {
  local i=1
  while [ "$i" -le "$MAXJOBS" ]; do
    take "$D/jobs/job-$i" && { JOBLOCK="$D/jobs/job-$i"; return 0; }
    i=$((i + 1))
  done
  return 1
}
copy_dir() { if [ "$1" = a ]; then echo "$D/$P"; else echo "$D/$P-$1"; fi; }
# Existing copies first: making a new one takes a checkout.
take_copy() {
  local pass l c
  for pass in old new; do
    for l in $LETTERS; do
      c=$(copy_dir "$l")
      if [ "$pass" = old ]; then [ -e "$c/.git" ] || continue; else [ -e "$c/.git" ] && continue; fi
      take "$D/lock-$P-$l" && { L=$l; C=$c; COPYLOCK="$D/lock-$P-$l"; return 0; }
    done
  done
  return 1
}
# Jobs that started in the last 150 seconds count at their declared size: they have not peaked yet.
room() {
  [ "$MINFREE" -eq 0 ] && [ "$GBMB" -eq 0 ] && return 0
  local m free pend l a g
  m=$(mem_mb)
  [ -z "$m" ] && return 0
  free=\${m%% *}
  pend=0
  for l in "$D"/jobs/job-*; do
    is_lock "$l" && [ "$l" != "$JOBLOCK" ] || continue
    a=$(lock_info "$l" started); g=$(lock_info "$l" gb)
    [ -n "$a" ] && [ $(( $(now) - a )) -lt 150 ] && pend=$(( pend + \${g:-0} ))
  done
  [ $(( free - pend - GBMB )) -ge "$MINFREE" ] && return 0
  WHY="free RAM $(gb "$free") GB"
  [ "$pend" -gt 0 ] && WHY="$WHY - starting jobs $(gb "$pend") GB"
  WHY="$WHY - this job $(gb "$GBMB") GB is below the $(gb "$MINFREE") GB minimum"
  return 1
}
holders() {
  local l
  for l in "$D"/jobs/job-* "$D"/lock-"$P"-[a-h]; do
    is_lock "$l" || continue
    mark holder "$(basename "$l")|$(( $(now) - $(lock_started "$l") ))|$(lock_info "$l" from)|$(lock_info "$l" label)"
  done
}
port_block() {
  mkdir -p "$D/ports"
  k=0
  while [ "$k" -lt ${PORT_BLOCKS} ]; do
    n=$(( (PHASH + k) % ${PORT_BLOCKS} ))
    if mkdir "$D/ports/$n" 2>/dev/null; then printf '%s\\n' "$P" > "$D/ports/$n/project"; echo "$n"; return; fi
    owner=$(cat "$D/ports/$n/project" 2>/dev/null)
    [ -z "$owner" ] && { sleep 1; owner=$(cat "$D/ports/$n/project" 2>/dev/null); }
    [ "$owner" = "$P" ] && { echo "$n"; return; }
    k=$((k + 1))
  done
  # All taken: reuse a block whose project folder was deleted, one process at a time.
  [ -n "$(find "$D/ports/.reclaim" -maxdepth 0 -mmin +2 2>/dev/null)" ] && rmdir "$D/ports/.reclaim" 2>/dev/null
  if mkdir "$D/ports/.reclaim" 2>/dev/null; then
    RECLAIM="$D/ports/.reclaim"
    k=0
    while [ "$k" -lt ${PORT_BLOCKS} ]; do
      n=$(( (PHASH + k) % ${PORT_BLOCKS} ))
      owner=$(cat "$D/ports/$n/project" 2>/dev/null)
      if { [ -z "$owner" ] || [ ! -d "$D/$owner" ]; } && mv "$D/ports/$n" "$D/ports/.old-$n-$$" 2>/dev/null; then
        rm -rf "$D/ports/.old-$n-$$"
        if mkdir "$D/ports/$n" 2>/dev/null; then
          printf '%s\\n' "$P" > "$D/ports/$n/project"
          rmdir "$RECLAIM"; RECLAIM=""
          echo "$n"; return
        fi
      fi
      k=$((k + 1))
    done
    rmdir "$RECLAIM"; RECLAIM=""
  fi
  echo "$PHASH"
}
# PIDs listening on a TCP port. Windows: a listening socket's foreign address is 0.0.0.0:0 or
# [::]:0; the state column itself is translated on some systems.
port_pids() {
  if [ "$WIN" = 1 ]; then
    netstat -ano 2>/dev/null | tr -d '\\r' | awk -v p=":$1" '$1 == "TCP" && ($3 == "0.0.0.0:0" || $3 == "[::]:0") && substr($2, length($2) - length(p) + 1) == p { print $NF }' | sort -u
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$1" 2>/dev/null | tr -s ' \\t' '\\n' | grep -E '^[0-9]+$' | sort -u
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  fi
}
stop_pid() {
  if [ "$WIN" = 1 ]; then MSYS_NO_PATHCONV=1 taskkill /PID "$1" /T /F >/dev/null 2>&1; else kill -TERM "$1" 2>/dev/null; fi
}
# A server the command started and did not stop keeps the ssh session open until it exits;
# stop it by PID, sparing anything that listened on the port before the job.
free_port() {
  hit=""
  for p in $(port_pids "$PORT"); do
    case " $PRE " in *" $p "*) continue ;; esac
    stop_pid "$p"; hit="$hit $p"
  done
  [ -z "$hit" ] && return
  mark portkill "$hit"
  if [ "$WIN" = 0 ]; then sleep 1; for p in $hit; do kill -KILL "$p" 2>/dev/null; done; fi
}
# Everything in the job's process group, with each Windows process tree under it.
kill_group() {
  kill -0 -- "-$1" 2>/dev/null || return 0
  if [ "$WIN" = 1 ]; then
    for w in $(ps | awk -v g="$1" '{ if ($1 !~ /^[0-9]+$/) { $1 = ""; $0 = $0 } if ($3 == g) print $4 }'); do
      MSYS_NO_PATHCONV=1 taskkill /PID "$w" /T /F >/dev/null 2>&1
    done
  fi
  kill -TERM -- "-$1" 2>/dev/null
  sleep 1
  kill -KILL -- "-$1" 2>/dev/null
  return 0
}
cleanup() {
  [ -n "$W" ] && kill "$W" 2>/dev/null
  [ -n "$HB" ] && kill -- "-$HB" 2>/dev/null
  [ -n "$JOB" ] && [ "$DONE" = 0 ] && kill_group "$JOB"
  [ -n "$RECLAIM" ] && rmdir "$RECLAIM" 2>/dev/null
  # a run that stopped between the fetch and the checkout leaves its incoming ref behind
  [ "$FETCHED" = 1 ] && git -C "$A" update-ref -d "refs/bulkhead/in-$T" 2>/dev/null
  release "$COPYLOCK"
  release "$JOBLOCK"
  [ -n "$U" ] && rm -rf "$INC/$U"
  return 0
}
fail() { mark fail "$1"; mark exit "\${2:-4}"; exit "\${2:-4}"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

git --version >/dev/null 2>&1 || fail "git is not installed on this machine (or not on PATH for ssh sessions)"
mkdir -p "$D/jobs" || fail "cannot create $(native "$D")"
# uploads no run picked up, such as one whose sender was interrupted
[ -d "$INC" ] && find "$INC" -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null

deadline=$(( $(now) + WAIT ))
told=0
while :; do
  WHY=""
  if take_job; then
    if ! take_copy; then
      if [ "$N" = 1 ]; then WHY="the only copy of $P is in use"; else WHY="all $N copies of $P are in use"; fi
    elif ! room; then
      release "$COPYLOCK"; COPYLOCK=""
    fi
    [ -n "$WHY" ] && { release "$JOBLOCK"; JOBLOCK=""; }
  else
    if [ "$MAXJOBS" = 1 ]; then WHY="the only job slot on this machine is taken"; else WHY="all $MAXJOBS job slots on this machine are taken"; fi
  fi
  [ -z "$WHY" ] && break
  if [ "$(now)" -ge "$deadline" ]; then holders; mark noroom "$WHY"; mark exit 3; exit 3; fi
  [ "$told" = 0 ] && { mark waiting "$WHY"; told=1; }
  # waits like sleep, and notices when the client has gone away (EOF). bash 3.2 (macOS) returns 1
  # for a timeout too, so there a quick return is what tells EOF apart.
  t0=$(now)
  read -r -t "$POLL" _
  rc=$?
  if [ "$rc" -eq 1 ]; then
    [ "\${BASH_VERSINFO[0]}" -ge 4 ] && exit 0
    [ $(( $(now) - t0 )) -lt $(( POLL - 1 )) ] && exit 0
  fi
done
# in its own process group, so stopping it also stops the sleep it is in. It also ends by itself
# once this script is gone, such as after a kill -9 that skipped the cleanup.
set -m
( while sleep 60 && kill -0 $$ 2>/dev/null; do now > "$JOBLOCK/beat"; now > "$COPYLOCK/beat"; done ) </dev/null >/dev/null 2>&1 &
HB=$!
set +m

# Copy a is a plain repository; the others are worktrees of it, so one fetch serves them all.
if [ ! -d "$A/.git" ]; then
  k=0
  until mkdir "$D/.init-$P" 2>/dev/null; do
    k=$((k + 1)); [ "$k" -gt 60 ] && rm -rf "$D/.init-$P"; sleep 1
  done
  [ -d "$A/.git" ] || { mkdir -p "$A" && git init -q "$A"; } || { rmdir "$D/.init-$P"; fail "git init failed in $(native "$A")"; }
  rmdir "$D/.init-$P"
fi
if [ "$HAS_BUNDLE" = 1 ]; then
  FETCHED=1
  git -C "$A" fetch -q "$INC/$U/bundle" "+HEAD:refs/bulkhead/in-$T" || fail "git fetch from the bundle failed"
fi
git -C "$A" cat-file -e "$SHA^{commit}" 2>/dev/null || fail "commit $SHA is not on this machine; run again to send it"
# A copy made from a copy a that has since been removed is a worktree of nothing: make it again.
# (rm does not follow the node_modules link inside it; on Windows, Git Bash treats a junction
# as a symlink too.)
if [ "$L" != a ] && [ -f "$C/.git" ] && ! git -C "$C" rev-parse --git-dir >/dev/null 2>&1; then
  mark repaired "copy $L was a worktree of a removed copy a; made it again"
  rm -rf "$C"
fi
if [ ! -e "$C/.git" ]; then
  git -C "$A" worktree prune 2>/dev/null
  [ -e "$C" ] && [ -n "$(ls -A "$C" 2>/dev/null)" ] && fail "$(native "$C") exists but is not a copy; move it away"
  git -C "$A" worktree add -q --detach "$C" "$SHA" >/dev/null || fail "git worktree add failed for $(native "$C")"
fi
# Ignored files and node_modules stay, so the next run does not reinstall.
git -C "$C" checkout -q -f --detach "$SHA" || fail "git checkout of $SHA failed in $(native "$C")"
git -C "$C" clean -fdq -e node_modules || fail "git clean failed in $(native "$C")"
git -C "$A" update-ref "refs/bulkhead/$L" "$SHA"
git -C "$A" update-ref -d "refs/bulkhead/in-$T" 2>/dev/null
if [ "$HAS_TAR" = 1 ]; then
  tar -xf "$INC/$U/changes.tar" -C "$C" || fail "unpacking the changed files failed"
fi
${lines.join('\n')}
# Other copies use copy a's node_modules, so one install serves them all.
if [ "$L" != a ] && [ -d "$A" ]; then
  (cd "$A" && find . -maxdepth 3 -name node_modules -type d -prune 2>/dev/null) | while read -r rel; do
    rel=\${rel#./}
    [ -e "$C/$rel" ] || [ -L "$C/$rel" ] && continue
    [ -d "$(dirname "$C/$rel")" ] || continue
    if [ "$WIN" = 1 ]; then
      MSYS_NO_PATHCONV=1 cmd /c mklink /J "$(cygpath -w "$C/$rel")" "$(cygpath -w "$A/$rel")" >/dev/null 2>&1
    else
      ln -s "$A/$rel" "$C/$rel"
    fi
  done
fi
[ -n "$U" ] && rm -rf "$INC/$U"
cd "$C/$SUB" 2>/dev/null || fail "no folder $SUB in $(native "$C")"

i=0
for x in a b c d e f g h; do [ "$x" = "$L" ] && break; i=$((i + 1)); done
PORT=$(( ${PORT_BASE} + $(port_block) * 8 + i ))
export BULKHEAD_PORT="$PORT" BULKHEAD_COPY="$L"
PRE=$(port_pids "$PORT" | tr '\\n' ' ')
[ -n "$(echo $PRE)" ] && mark portbusy "$PRE"
mark start "$L $PORT $(native "$C")"
DISC="$COPYLOCK/disconnected"
# SIGPIPE back to the default the command would have anywhere else: ignored, "yes | head"
# would print errors and a pipeline under pipefail would fail. The ssh channel (fd 0) is not
# the command's to read.
set -m
( trap - PIPE; exec "$BASH" -c "$CMD" ) </dev/null &
JOB=$!
set +m
# The watcher reads the ssh channel. EOF means the client is gone (Ctrl-C, a killed tool call,
# a dropped network), so the job is stopped instead of holding the copy for hours. 0<&0: without
# job control, bash gives a background command /dev/null for stdin unless it names one.
( while read -r _; do :; done; : > "$DISC"; kill_group "$JOB" ) 0<&0 >/dev/null 2>&1 &
W=$!
wait "$JOB"
RC=$?
DONE=1
kill "$W" 2>/dev/null; W=""
kill_group "$JOB"
free_port
[ -f "$DISC" ] && exit "$RC"
mark exit "$RC"
if [ "$HOLD" = 1 ]; then
  mark hold
  while read -r _; do :; done
fi
exit "$RC"
`)
}

module.exports = { prelude, probeScript, uploadScript, fetchScript, statusScript, runScript, hash, q, PORT_BASE, PORT_BLOCKS, LETTERS }
