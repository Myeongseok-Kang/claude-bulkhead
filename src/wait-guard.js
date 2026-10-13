'use strict'
const { runHook, setting, blocked } = require('./hook')
const shell = require('./shell')

const DEFAULT_TOOL_TIMEOUT_S = 120

// Shell, PowerShell and cmd.exe waits in seconds: sleep 300, Start-Sleep 300, timeout /t 300,
// ping -n 301 127.0.0.1, [Threading.Thread]::Sleep(300000).
function sleeps(cmd) {
  const out = []
  for (const m of cmd.matchAll(/(?:^|[\s;&|({])sleep\s+(?:(\d+(?:\.\d+)?)([smhd]?)\b|(inf(?:inity)?)\b)/g)) {
    if (m[3]) { out.push(Infinity); continue }
    const n = parseFloat(m[1])
    out.push(n * ({ m: 60, h: 3600, d: 86400 }[m[2]] || 1))
  }
  for (const m of cmd.matchAll(/Start-Sleep\s+(?:(-s(?:econds)?|-m(?:illiseconds)?)\s+)?(\d+(?:\.\d+)?)/gi)) {
    const n = parseFloat(m[2])
    out.push(m[1] && /^-m/i.test(m[1]) ? n / 1000 : n)
  }
  for (const m of cmd.matchAll(/(?:^|[\s;&|({])timeout(?:\.exe)?\s+\/t\s+(-?\d+)/gi)) {
    out.push(Number(m[1]) < 0 ? Infinity : Number(m[1]))
  }
  for (const m of cmd.matchAll(/\[(?:System\.)?Threading\.Thread\]::Sleep\(\s*(\d+)\s*\)/gi)) out.push(Number(m[1]) / 1000)
  for (const m of cmd.matchAll(/(?:^|[\s;&|({])ping(?:\.exe)?\b([^\n;&|)]*)/gi)) {
    const w = pingWait(m[1])
    if (w) out.push(w)
  }
  return out
}

// ping -n 301 waits 300 s on Windows, ping -c 300 -i 1 about 300 s elsewhere, ping -t forever.
function pingWait(args) {
  if (/(?:^|\s)-t\b/.test(args) && process.platform === 'win32') return Infinity
  const n = /(?:^|\s)-n\s+(\d+)(?![.\d])/.exec(args)
  if (n) return Math.max(0, Number(n[1]) - 1)
  const c = /(?:^|\s)-c\s*(\d+)/.exec(args)
  const i = /(?:^|\s)-i\s*(\d+(?:\.\d+)?)/.exec(args)
  if (c) return Math.max(0, Number(c[1]) - 1) * (i ? Number(i[1]) : 1)
  const deadline = /(?:^|\s)-w\s*(\d+)/.exec(args)
  if (deadline && process.platform !== 'win32') return Number(deadline[1])
  return process.platform === 'win32' ? 3 : Infinity
}

// Commands that follow a log or a stream until they are stopped.
function follows(argv) {
  const b = shell.bin(argv[0])
  const rest = argv.slice(1)
  if (b === 'tail') return rest.some(a => /^-[a-zA-Z0-9]*[fF]/.test(a) || a === '--follow' || a.startsWith('--follow='))
  if (/^(?:get-content|gc|cat|type)$/i.test(argv[0])) return rest.some(a => /^-wait$/i.test(a))
  if (b === 'journalctl') return rest.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--follow')
  if (/^(?:docker|podman|kubectl|oc|docker-compose)$/.test(b) && rest.includes('logs')) return rest.some(a => a === '-f' || a === '--follow')
  return false
}

// A loop inside an interpreter's code: Infinity for while loops, the count for range(N),
// N.times or for (i = 0; i < N; ...), and 1 for no loop.
function codeLoops(code) {
  if (/\bwhile\b|\bloop\s+do\b|\bfor\s*\(\s*;\s*;|\bsetInterval\s*\(/.test(code)) return Infinity
  let best = 1
  for (const m of code.matchAll(/\brange\(\s*(?:(\d+)\s*,\s*)?(\d+)\s*\)/g)) best = Math.max(best, Number(m[2]) - Number(m[1] || 0))
  for (const m of code.matchAll(/\b(\d+)\.times\b/g)) best = Math.max(best, Number(m[1]))
  for (const m of code.matchAll(/\bfor\s*\([^;)]{0,80};\s*\w+\s*<=?\s*(\d+)/g)) best = Math.max(best, Number(m[1]))
  return best
}

// Worst-case wait in seconds of python -c, node -e, ruby -e, perl -e or php -r code:
// sleep(300), time.sleep(300), sleep 300, setTimeout(f, 300000).
function codeWait(code) {
  const s = []
  for (const m of code.matchAll(/\bsleep\s*\(?\s*(\d+(?:\.\d+)?)\s*\)?/g)) s.push(Number(m[1]))
  for (const m of code.matchAll(/\bsetTimeout\s*\(([^;]{0,300}?),\s*(\d+(?:\.\d+)?)\s*\)/g)) s.push(Number(m[2]) / 1000)
  if (!s.length) return 0
  const loops = codeLoops(code)
  return loops > 1 ? loops * s.reduce((a, b) => Math.max(a, b), 0) : s.reduce((a, b) => a + b, 0)
}

const INTERPRETER = /^(?:python[\d.]*|py|pythonw|node|deno|bun|ruby|perl|php)$/
const INTERPRETER_HEREDOC = /(?:^|[\s;&|(])(?:python[\d.]*|py|node|deno|bun|ruby|perl|php)(?:\.exe)?(?:\s+-)?\s*$/
const CODE_FLAG = { python: /^-c$/, node: /^(?:-e|--eval|-p|--print)$/, ruby: /^-e$/, perl: /^-[Ee]$/, php: /^-r$/ }

function codeOf(argv) {
  const b = shell.bin(argv[0])
  if (!INTERPRETER.test(b)) return null
  const kind = /^py/.test(b) ? 'python' : /^(?:node|deno|bun)$/.test(b) ? 'node' : b
  if (/^(?:deno|bun)$/.test(b) && argv[1] === 'eval') return argv[2] || null
  const i = argv.findIndex((a, k) => k > 0 && CODE_FLAG[kind].test(a))
  return i > 0 ? argv[i + 1] || null : null
}

// Inert commands only print or search text: echo "sleep 600", git log -S "sleep 300".
const INERT = /^(?:echo|printf|git|grep|egrep|rg|write-host|write-output|select-string|sls)$/i
const BACKGROUND = /^(?:start-job|sajb|start-threadjob)$/i

// Blanks out inert commands, keeping every offset, and collects interpreter code waits.
function scan(text, mode) {
  const { cmds } = shell.lex(text, mode)
  const cut = []
  const code = []
  let follow = false
  for (const c of cmds) {
    const s = shell.strip(text, c.words, mode)
    if (!s.argv.length) continue
    const argv = s.argv.map(w => w.v)
    // inert commands, and PowerShell jobs, which run in the background like `&`
    // and `docker exec -d` or `docker run -d`, which return as soon as the container starts the command
    const detached = s.remote && argv.some(v => v === '-d' || v === '--detach')
    if (INERT.test(shell.bin(argv[0])) || BACKGROUND.test(argv[0]) || detached) { cut.push([s.argv[0].s, c.e]); continue }
    const src = codeOf(argv)
    if (src) code.push(codeWait(src))
    if (follows(argv)) follow = true
  }
  if (!cut.length) return { text, code, follow }
  cut.sort((a, b) => a[0] - b[0])
  let out = ''
  let last = 0
  for (const [s, e] of cut) {
    if (e <= last) continue
    const from = Math.max(s, last)
    out += text.slice(last, from) + ' '.repeat(e - from)
    last = e
  }
  return { text: out + text.slice(last), code, follow }
}

// Upper bound on iterations, or Infinity when the loop has no fixed count.
function loopCount(cmd) {
  if (/\b(until|while)\b/i.test(cmd)) return Infinity
  let best = null
  const take = n => (best = best === null ? n : Math.max(best, n))
  for (const m of cmd.matchAll(/\bseq\s+(?:(\d+)\s+)?(?:(\d+)\s+)?(\d+)/g)) {
    const nums = [m[1], m[2], m[3]].filter(Boolean).map(Number)
    if (nums.length === 1) take(nums[0])
    else if (nums.length === 2) take(nums[1] - nums[0] + 1)
    else take(Math.floor((nums[2] - nums[0]) / nums[1]) + 1)
  }
  for (const m of cmd.matchAll(/\{(\d+)\.\.(\d+)\}/g)) take(Number(m[2]) - Number(m[1]) + 1)
  // for x in a b c; do: the list runs to the next `;`. A `for` inside a list already read is
  // skipped, so the text is read once however many `for`s it holds.
  let listEnd = -1
  for (const m of cmd.matchAll(/\bfor\s+\w+\s+in\s+/g)) {
    const from = m.index + m[0].length
    if (from <= listEnd) continue
    listEnd = cmd.indexOf(';', from)
    if (listEnd < 0) break
    const list = cmd.slice(from, listEnd)
    if (!/[$`(]/.test(list) && /^;\s*do\b/.test(cmd.slice(listEnd, listEnd + 16))) take(list.trim().split(/\s+/).length)
  }
  // bounded repeat: an unbounded [^;]* rescans to the end of the text from every `for (`
  for (const m of cmd.matchAll(/\bfor\s*\(\(?[^;]{0,200};\s*\$?\w+\s*(?:<=?|-lt|-le)\s*(\d+)/gi)) take(Number(m[1]))
  for (const m of cmd.matchAll(/\b(\d+)\.\.(\d+)\b/g)) take(Number(m[2]) - Number(m[1]) + 1)
  return best === null ? Infinity : best
}

// for/while/until ... do, PowerShell loops and ForEach-Object. Two plain searches instead of
// /\b(for|while|until)\b[\s\S]*?\bdo\b/, which rescans to the end from every unmatched `for`.
function hasLoop(cmd) {
  const head = /\b(?:for|while|until)\b/.exec(cmd)
  return (head && /\bdo\b/.test(cmd.slice(head.index))) ||
    /\b(while|for|foreach|do)\s*[({]/i.test(cmd) ||
    /ForEach-Object|\|\s*%\s*\{/i.test(cmd)
}

const QUOTED = /"[^"]*"|'[^']*'/g

const OPENERS = new Set(['do', 'if', 'case'])
const CLOSERS = new Set(['done', 'fi', 'esac'])

// Splits a shell line into top-level lists, each with the operator that ends it
// (';', '\n', '&' or ''). && and || stay inside a list, as in bash, where `a && b &`
// backgrounds both. Quotes, loops, groups and subshells are kept whole.
function topLevelLists(cmd) {
  const out = []
  let depth = 0
  let start = 0
  let quote = null
  const push = (end, op) => {
    out.push({ text: cmd.slice(start, end), op })
    start = end + op.length
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"') i++
      continue
    }
    if (c === '\\') { i++; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '(' || c === '{') { depth++; continue }
    if (c === ')' || c === '}') { depth = Math.max(0, depth - 1); continue }
    if (/[a-z]/i.test(c) && (i === 0 || /[\s;&|]/.test(cmd[i - 1]))) {
      const word = /^[\w.-]+/.exec(cmd.slice(i, i + 64))[0]
      if (OPENERS.has(word)) depth++
      else if (CLOSERS.has(word)) depth = Math.max(0, depth - 1)
      i += word.length - 1
      continue
    }
    if (depth) continue
    if (c === ';' || c === '\n') push(i, c)
    else if (c === '&') {
      const prev = cmd[i - 1]
      const next = cmd[i + 1]
      // &&, >&, &>, |&, 2>&1 are not background operators
      if (next === '&') { i++; continue }
      if (prev === '>' || prev === '|' || prev === '<' || next === '>') continue
      push(i, '&')
    }
  }
  if (start < cmd.length) out.push({ text: cmd.slice(start), op: '' })
  return out
}

// A list ending in a single & runs as a background job: the tool call returns without waiting
// for it, so its sleeps cost nothing. A later `wait` brings them back into the foreground.
function dropBackgrounded(cmd) {
  const lists = topLevelLists(cmd)
  if (!lists.some(l => l.op === '&')) return cmd
  if (lists.some(l => l.op !== '&' && /^\s*wait\b/.test(l.text))) return cmd
  return lists.filter(l => l.op !== '&').map(l => l.text).join('\n')
}

// Worst-case wait in seconds, capped by the tool timeout. Returns null when within the limit.
function judge(cmd, timeoutMs, maxSec = 180, mode = 'sh') {
  const opened = shell.unwrap(shell.prepare(String(cmd || ''), mode), mode, 0, { remote: true })
  const { text, code, follow } = scan(dropBackgrounded(opened), mode)
  // python3 - <<'EOF' ... EOF: the body is the interpreter's code
  if (opened.includes('<<')) {
    for (const d of shell.heredocs(opened, prefix => INTERPRETER_HEREDOC.test(prefix))) code.push(codeWait(d.body))
  }
  // Quoted text is an argument, not shell code: a `for (` inside node -e "..." is not a loop.
  const bare = text.replace(QUOTED, '_')
  const s = sleeps(bare).concat(code.filter(n => n > 0))
  if (follow) s.push(Infinity)
  if (!s.length) return null
  const wrapped = bare.match(/\b(?:g?timeout)\s+(?:-\w+\s+)*(\d+)s?\b/)
  if (wrapped && Number(wrapped[1]) <= maxSec) return null
  const cap = Number(timeoutMs) > 0 ? Number(timeoutMs) / 1000 : DEFAULT_TOOL_TIMEOUT_S
  const loop = hasLoop(bare)
  const worst = loop ? loopCount(bare) * s.reduce((a, b) => Math.max(a, b), 0) : s.reduce((a, b) => a + b, 0)
  const est = Math.min(worst, cap)
  return est > maxSec ? { est, maxSec, rule: follow && !loop ? 'follow' : loop ? 'poll-loop' : 'long-sleep' } : null
}

function message({ est, maxSec }) {
  return `[bulkhead] wait-guard: this command can sit in the foreground for about ${Math.round(est)}s (limit ${maxSec}s).\n` +
    'A foreground wait holds the session: it cannot answer the user or do anything else until the command returns. ' +
    'The prompt cache also expires after about 5 minutes without a request, so the request after a long wait writes the whole context to the cache again instead of reading it.\n' +
    'Run the same loop with run_in_background: true and end your turn; you are notified once when it exits. For example:\n' +
    '  until [ -f out/DONE ]; do sleep 15; done; tail -20 out/log.txt\n' +
    'For a one-off check, skip the sleep and read the output file now.'
}

if (require.main === module) {
  runHook('wait-guard', input => {
    const ti = input.tool_input || {}
    if (ti.run_in_background || typeof ti.command !== 'string') return
    const verdict = judge(ti.command, ti.timeout, setting('waitGuard.limitSeconds', 180), shell.modeFor(input))
    if (!verdict) return
    return blocked('wait-guard', verdict.rule, input, message(verdict))
  })
}

module.exports = { judge, message, topLevelLists, dropBackgrounded }
