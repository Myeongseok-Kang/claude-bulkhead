'use strict'
const { runHook, blocked, setting } = require('./hook')
const shell = require('./shell')

// Programs that other sessions, editors and the user are likely running too.
const SHARED = [
  'node', 'python', 'python3', 'py', 'pythonw', 'ruby', 'java', 'javaw', 'dotnet',
  'chrome', 'chromium', 'chrome-headless-shell', 'msedge', 'firefox',
  'bash', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd', 'conhost',
  'git', 'ssh', 'sshd', 'code', 'claude',
  'npm', 'npx', 'pnpm', 'yarn', 'deno', 'bun', 'tsx', 'ts-node',
  'gradle', 'adb', 'ffmpeg', 'docker', 'vitest', 'jest', 'next', 'vite', 'esbuild', 'webpack',
]
const bare = n => String(n).trim().replace(/^["']+|["']+$/g, '').toLowerCase().replace(/\.exe$/, '')

// killGuard.allowNames takes names off the list; killGuard.extraSharedNames adds some.
function nameList({ allowNames = [], extraSharedNames = [] } = {}) {
  const allow = new Set(allowNames.map(bare))
  return [...new Set([...SHARED.filter(n => !allow.has(n)), ...extraSharedNames.map(bare).filter(Boolean)])]
}

const globRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')

// A process name as Get-Process, Stop-Process -Name and taskkill /IM take it: exact, or a
// wildcard such as node* that matches a shared name.
function nameHits(value, names) {
  const v = bare(value)
  if (!v) return false
  if (/[*?]/.test(v)) {
    if (v.length > 200) return false
    const re = globRe(v)
    return names.some(n => re.test(n) || re.test(n + '.exe'))
  }
  return names.includes(v)
}

// pkill -f "python scripts/worker.py" names a script, so only that script matches.
function scopedPattern(pattern) {
  const first = String(pattern).trim().split(/\s+/)[0] || ''
  return /[\\/]|\.(?:py|js|mjs|cjs|ts|mts|rb|php|sh|jar|ps1)\b/i.test(first) || /[\\/]|\.(?:py|js|mjs|cjs|ts|rb|php|sh|jar|ps1)\b/i.test(pattern)
}

// A pkill, pgrep or grep pattern. Without -f it is a regular expression matched against the
// process name; with -f (and for grep over ps output) against the whole command line, where the
// first word decides which program it hits. [n]ode is node.
function patternHits(pattern, names, { full = false, exact = false } = {}) {
  let p = String(pattern || '').trim()
  if (!p || p.length > 500) return false
  if (scopedPattern(p)) return false
  if (full) p = p.split(/\s+/)[0]
  if (!p) return false
  // a plain word names one program: pkill node does not reach ts-node
  if (!/[.*+?^${}()|[\]\\]/.test(p.replace(/\.exe$/i, ''))) return names.includes(bare(p))
  let re
  try {
    re = new RegExp(exact ? `^(?:${p})$` : p, 'i')
  } catch {
    return names.includes(bare(p))
  }
  return names.some(n => re.test(n) || (!exact && re.test(n + '.exe')))
}

const PKILL_VALUE = new Set(['-g', '-G', '-P', '-s', '-t', '-u', '-U', '-F', '--signal', '--pgroup', '--group', '--parent', '--session', '--terminal', '--euid', '--uid', '--pidfile', '--ns', '--nslist', '--env'])
const KILLALL_VALUE = new Set(['-s', '-u', '-o', '-y', '-n', '--signal', '--user', '--older-than', '--younger-than', '--ns', '--context'])
// pkill -P <ppid>, -s <sid>, -t <tty>, -g <pgrp> and -F <pidfile> only reach a known group of processes
const PKILL_SCOPE_OPT = /^(?:-[PstgF]|--(?:parent|session|terminal|pgroup|pidfile))$/
// -s, -P and -g take numeric IDs; `pkill -s KILL node` mistakes -s for a signal and still kills by name
const NUMERIC_SCOPE = /^(?:-[Psg]|--(?:parent|session|pgroup))$/
const IDS = /^(?:\d+|\$[\w{}()$#!?-]+)(?:,(?:\d+|\$[\w{}()$#!?-]+))*$/
const PKILL_SCOPE = { test: ([o, v]) => PKILL_SCOPE_OPT.test(o) && (!NUMERIC_SCOPE.test(o) || IDS.test(String(v == null ? '' : v))) }

// Options and operands of pkill, pgrep or killall.
function parseKillByName(argv, valued) {
  const opts = []
  const operands = []
  let signal = null
  for (let k = 1; k < argv.length; k++) {
    const v = argv[k]
    if (operands.length || !/^-./.test(v)) {
      if (v === '--' && !operands.length) continue
      operands.push(v)
      continue
    }
    const eq = /^(--[\w-]+)=(.*)$/.exec(v)
    if (eq) { opts.push([eq[1], eq[2]]); if (eq[1] === '--signal') signal = eq[2]; continue }
    if (valued.has(v)) {
      opts.push([v, argv[k + 1]])
      if (v === '--signal' || (v === '-s' && valued === KILLALL_VALUE)) signal = argv[k + 1]
      k++
      continue
    }
    if (/^-(?:\d+|[A-Z][A-Z0-9+-]*|SIG\w+)$/.test(v)) { signal = v.slice(1); continue }
    opts.push([v, null])
  }
  const flags = opts.filter(([o]) => /^-[a-zA-Z]+$/.test(o)).map(([o]) => o.slice(1)).join('')
  return { opts, operands, signal, flags }
}

const zeroSignal = s => s != null && /^(?:0|SIG0)$/i.test(String(s))

function checkPkill(argv, names) {
  const b = shell.bin(argv[0])
  if (b === 'pkill') {
    const p = parseKillByName(argv, PKILL_VALUE)
    if (zeroSignal(p.signal) || p.opts.some(ov => PKILL_SCOPE.test(ov))) return null
    if (p.operands.length && patternHits(p.operands[0], names, { full: /f/.test(p.flags) || p.opts.some(([o]) => o === '--full'), exact: /x/.test(p.flags) })) {
      return ['pkill', 'pkill/killall matches every process with that name']
    }
  }
  if (b === 'killall') {
    const p = parseKillByName(argv, KILLALL_VALUE)
    if (zeroSignal(p.signal)) return null
    const regex = /r/.test(p.flags) || p.opts.some(([o]) => o === '--regexp')
    if (p.operands.slice(0, 100).some(o =>(regex ? patternHits(o, names, { exact: true }) : names.includes(bare(o))))) {
      return ['pkill', 'pkill/killall matches every process with that name']
    }
  }
  return null
}

// A comma list after a flag: -Name node,python or -Name node, python. Real lists are short; the
// first 256 names are enough, and a longer list is not copied name by name.
const MAX_LIST = 256

function listAfter(argv, k) {
  const out = []
  for (let j = k; j < argv.length && out.length < MAX_LIST; j++) {
    for (const s of argv[j].split(',', MAX_LIST)) {
      const t = s.trim()
      if (t && out.length < MAX_LIST) out.push(t)
    }
    if (!argv[j].endsWith(',') && !(argv[j + 1] || '').startsWith(',')) break
  }
  return out
}

function checkTaskkill(argv, names) {
  if (shell.bin(argv[0]) !== 'taskkill') return null
  let byPid = false
  const images = []
  const filters = []
  for (let k = 1; k < argv.length; k++) {
    const o = argv[k].replace(/^(?:\/\/?|-)/, '').toLowerCase()
    if (argv[k].toLowerCase() === o) continue
    if (o === 'im') images.push(argv[++k] || '')
    else if (o === 'pid') { byPid = true; k++ } else if (o === 'fi') filters.push(argv[++k] || '')
  }
  const hit = images.find(i => nameHits(i, names))
  if (hit) return ['taskkill-im', `taskkill /IM kills every process with that name: ${argv.join(' ')}`]
  for (const f of filters) {
    if (/\bpid\s+(?:eq|ne|gt|lt|ge|le)\b/i.test(f) || byPid) continue
    const img = /\bimagename\s+eq\s+(\S+)/i.exec(f)
    if (img && !nameHits(img[1], names)) continue
    return ['taskkill-filter', `taskkill /FI picks processes by filter, not by PID: ${argv.join(' ')}`]
  }
  return null
}

const STOP = /^(?:stop-process|spps|kill)$/i
const NAME_FLAG = /^-(?:n|na|nam|name|processname)(?::(.*))?$/i

function checkStopProcess(argv, names) {
  if (!STOP.test(argv[0])) return null
  if (argv.some(a => /^-whatif$/i.test(a))) return null
  for (let k = 1; k < argv.length; k++) {
    const m = NAME_FLAG.exec(argv[k])
    if (!m) continue
    const list = m[1] ? m[1].split(',') : listAfter(argv, k + 1)
    if (list.some(n => nameHits(n, names))) return ['stop-process-name', 'Stop-Process -Name kills every process with that name']
  }
  return null
}

// wmic process where name='node.exe' delete, wmic process where "name like 'node%'" call terminate
function checkWmic(argv, names) {
  if (shell.bin(argv[0]) !== 'wmic') return null
  const text = argv.slice(1).join(' ')
  if (!/\bprocess\b/i.test(text) || !/\b(?:delete|terminate)\b/i.test(text)) return null
  if (/\b(?:processid|commandline|executablepath|parentprocessid)\b/i.test(text)) return null
  if (wmiNameHits(text, names)) return ['wmic-name', 'wmic process where name=... deletes every process with that name']
  return null
}

// Name='node.exe', name like 'node%' in a WQL filter
function wmiNameHits(text, names) {
  for (const m of text.matchAll(/\bname\s*(=|like)\s*['"\\]*([^'"\\\s)]+)/gi)) {
    const v = m[1].toLowerCase() === 'like' ? m[2].replace(/%/g, '*').replace(/_/g, '?') : m[2]
    if (nameHits(v, names)) return true
  }
  return false
}

// Where-Object { $_.Name -eq 'node' }, ? ProcessName -like node*, ... and whether the filter
// narrows the selection to known processes (Id, CommandLine, Path).
function whereFilter(text, names) {
  const scoped = /\b(?:Id|ProcessId|CommandLine|Path|ExecutablePath|ParentProcessId)\b/i.test(text)
  let byName = false
  for (const m of text.matchAll(/\b(?:Name|ProcessName|ImageName)\b['"]?\s*-[ic]?(eq|like|match|in|contains)\s+([^|}]{1,200})/gi)) {
    const op = m[1].toLowerCase()
    const values = m[2].split(/[\s,]+/).map(s => s.replace(/^[('"]+|[)'"]+$/g, '')).filter(Boolean)
    if (op === 'match') byName = byName || values.slice(0, 1).some(v => patternHits(v, names))
    else byName = byName || values.some(v => nameHits(v, names))
  }
  return { scoped, byName }
}

// Commands that only print or search text: their words are never a kill or a selection.
const INERT = /^(?:git|fgrep|rg|ag|echo|printf|cat|less|more|head|tail|select-string|sls|write-host|write-output|write-error|write-warning|write-verbose|out-host|man|help|get-help|which|type|get-command|gcm)$/i
const PS_SOURCE = /^(?:get-process|gps)$/i
const PS_SINKS = /^(?:stop-process|spps|invoke-cimmethod|remove-ciminstance|remove-wmiobject)$/i

// Does any of these commands select processes by a shared name, and does another one kill what
// they select? Commands of one statement are judged together: a pipe, $( ) and a loop body all
// carry the PIDs from one to the other.
function judgeStatement(cmds, names, mode, vars) {
  let selector = null
  let scoped = false
  let killer = false
  let usesVar = false
  let whereDepth = 0
  const listsProcesses = cmds.some(x => x.argv.length && /^(?:ps|tasklist|wmic|get-process|gps)$/i.test(shell.bin(x.argv[0])))
  for (const c of cmds) {
    const argv = c.argv
    if (!argv.length) continue
    const b = shell.bin(argv[0])
    // direct kills by name
    const direct = checkPkill(argv, names) || checkTaskkill(argv, names) || checkStopProcess(argv, names) || checkWmic(argv, names)
    if (direct) return direct
    if (c.remote) continue
    // killers
    if (isKiller(argv, mode)) killer = true
    for (const w of argv) {
      if (/\.(?:kill|terminate)\s*\(/i.test(w)) killer = true
      if (vars.size && /\$\{?(\w+)/.test(w) && [...w.matchAll(/\$\{?(\w+)/g)].some(m => vars.has(m[1].toLowerCase()))) usesVar = true
    }
    for (let k = 0; k < argv.length - 1; k++) {
      if (/^(?:foreach-object|%)$/i.test(argv[k]) && /^(?:kill|terminate)$/i.test(argv[k + 1])) killer = true
      if (k > 0 && (argv[k - 1] === '{' || argv[k - 1].endsWith('{')) && isKiller(argv.slice(k, k + 8), mode)) killer = true
    }
    // selectors by name
    if (b === 'pgrep') {
      const p = parseKillByName(argv, PKILL_VALUE)
      if (!p.opts.some(ov => PKILL_SCOPE.test(ov)) && p.operands.length &&
          patternHits(p.operands[0], names, { full: /f/.test(p.flags), exact: /x/.test(p.flags) })) selector = selector || 'pgrep-kill'
    } else if (b === 'pidof') {
      if (argv.slice(1).some(a => !a.startsWith('-') && names.includes(bare(a)))) selector = selector || 'pgrep-kill'
    } else if ((b === 'grep' || b === 'egrep' || b === 'findstr') && listsProcesses) {
      if (grepHits(argv, names)) selector = selector || 'ps-grep-kill'
    } else if (b === 'ps' && mode !== 'ps') {
      const i = argv.findIndex(a => a === '-C' || a === '--command')
      if (i > 0 && (argv[i + 1] || '').split(',').some(n => names.includes(bare(n)))) selector = selector || 'ps-grep-kill'
    }
    const srcAt = argv.findIndex(a => PS_SOURCE.test(a) || (mode === 'ps' && /^ps$/i.test(a)))
    if (srcAt >= 0) {
      const rest = argv.slice(srcAt + 1)
      if (rest.some(a => /^-(?:id|inputobject)$/i.test(a))) scoped = true
      const picked = rest[0] && !rest[0].startsWith('-') ? listAfter(rest, 0) : []
      rest.forEach((a, k) => {
        const m = NAME_FLAG.exec(a)
        if (m) for (const n of m[1] ? m[1].split(',', MAX_LIST) : listAfter(rest, k + 1)) picked.push(n)
      })
      if (picked.some(n => nameHits(n, names))) selector = selector || 'get-process-pipe'
    }
    // a Where-Object block that a ( ) inside it split into several commands continues here
    const whereStart = /^(?:where-object|where|\?)$/i.test(argv[0]) || /^\?\{/.test(argv[0])
    if (whereStart || (whereDepth > 0 && !c.sub)) {
      const joined = argv.join(' ')
      if (whereStart) whereDepth = 0
      whereDepth += (joined.match(/\{/g) || []).length - (joined.match(/\}/g) || []).length
      const w = whereFilter(joined, names)
      if (w.scoped) scoped = true
      if (w.byName) selector = selector || 'get-process-pipe'
    }
    if (argv.some(a => /win32_process/i.test(a))) {
      const text = argv.join(' ')
      if (/\b(?:ProcessId|CommandLine|ExecutablePath|ParentProcessId|Handle)\s*(?:=|-eq|-like)/i.test(text)) scoped = true
      if (wmiNameHits(text, names)) selector = selector || 'win32-process-name'
    }
  }
  if (selector && !scoped && killer) return [selector, SELECTOR_WHY[selector]]
  if (usesVar && killer) return ['pgrep-kill', SELECTOR_WHY['pgrep-kill']]
  return selector && !scoped ? { assign: true } : null
}

const SELECTOR_WHY = {
  'pgrep-kill': 'pgrep <name> feeding kill matches every process with that name',
  'ps-grep-kill': 'ps | grep <name> | kill matches every process with that name',
  'get-process-pipe': 'Get-Process <name> | Stop-Process kills every process with that name',
  'win32-process-name': 'Win32_Process selected by Name alone is terminated',
}

function isKiller(argv, mode) {
  const b = shell.bin(argv[0])
  if (/^invoke-cimmethod$/i.test(argv[0])) return argv.some(a => /^terminate$/i.test(a))
  if (PS_SINKS.test(argv[0]) || /^(?:taskkill|tskill)$/.test(b)) return !argv.some(a => /^-whatif$/i.test(a))
  if (b === 'kill') {
    // kill -0 and kill -l only test or list
    return !argv.slice(1).some((a, i, r) => a === '-0' || a === '-l' || a === '-L' || (a === '-s' && r[i + 1] === '0'))
  }
  return mode === 'ps' && /^kill$/i.test(argv[0])
}

const GREP_VALUE = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude', '--label', '--color', '--colour'])

function grepHits(argv, names) {
  if (shell.bin(argv[0]) === 'findstr') {
    if (argv.some(a => /^\/v$/i.test(a))) return false
    return argv.slice(1).filter(a => !/^\//.test(a)).some(w => w.split(/\s+/).some(x => patternHits(x, names, { full: true })))
  }
  let invert = false
  const patterns = []
  const operands = []
  for (let k = 1; k < argv.length; k++) {
    const v = argv[k]
    if (operands.length || !/^-./.test(v)) { operands.push(v); continue }
    if (v === '-e' || v === '--regexp') { patterns.push(argv[++k] || ''); continue }
    if (GREP_VALUE.has(v)) { k++; continue }
    if (/^-[a-zA-Z]*v[a-zA-Z]*$/.test(v) || v === '--invert-match') invert = true
  }
  if (invert) return false
  if (!patterns.length && operands.length) patterns.push(operands[0])
  return patterns.some(p => patternHits(p, names, { full: true }))
}

// `pids=$(pgrep node)` or `$procs = Get-Process node`: the variable now holds PIDs by name.
function assignedVar(cmds) {
  const first = cmds.find(c => !c.sub)
  if (!first) return null
  const w = first.words[0]
  if (!w) return null
  const sh = /^([A-Za-z_]\w*)=/.exec(w.v)
  if (sh) return sh[1].toLowerCase()
  const ps = /^\$([A-Za-z_]\w*)$/.exec(first.argv[0])
  if (ps && first.argv[1] === '=') return ps[1].toLowerCase()
  return null
}

// { rule, why } for the first kill by name, or null.
function classify(cmd, names = {}, mode = 'sh') {
  const list = nameList(names)
  const text = shell.unwrap(shell.prepare(String(cmd || ''), mode), mode)
  return judge(text, list, mode)
}

// Every kill this guard knows names one of these words, so text without them needs no parsing.
const KILL_WORD = /kill|stop-process|spps|terminate|remove-ciminstance|rcim|remove-wmiobject|rwmi|wmic/i

function judge(text, names, mode) {
  if (!KILL_WORD.test(text)) return null
  const { cmds, unterminated } = shell.lex(text, mode)
  const hit = judgeLexed(text, cmds, names, mode)
  if (hit || !unterminated) return hit
  // a quote that never closes: read the text again without quotes, as the shell never would
  return judgeLexed(text, shell.lex(text.replace(/["'`]/g, ' '), mode).cmds, names, mode)
}

function judgeLexed(text, lexed, names, mode) {
  const bySeg = new Map()
  const add = (seg, x) => {
    if (!bySeg.has(seg)) bySeg.set(seg, [])
    bySeg.get(seg).push(x)
  }
  let forF = false
  for (const c of lexed) {
    const s = shell.strip(text, c.words, mode)
    const argv = s.argv.map(w => w.v)
    // cmd's for /f ... in ('tasklist ^| findstr node') do ...: the quoted command runs too
    if (forF && argv.length) {
      forF = false
      const inner = argv.join(' ').replace(/^'|'$/g, '').replace(/\^([|&<>^])/g, '$1')
      if (inner !== argv.join(' ') || argv.length === 1) {
        for (const ic of shell.lex(inner, 'cmd').cmds) {
          const iv = shell.strip(inner, ic.words, 'cmd').argv.map(w => w.v)
          if (iv.length && !INERT.test(shell.bin(iv[0]))) add(c.seg, { argv: iv, words: ic.words, remote: false, sub: true })
        }
        continue
      }
    }
    if (/^for$/i.test(argv[0] || '') && /^\/f$/i.test(argv[1] || '') && /^in$/i.test(argv[argv.length - 1])) forF = true
    if (argv.length && INERT.test(shell.bin(argv[0]))) continue
    add(c.seg, { argv, words: c.words, remote: s.remote, sub: c.sub })
  }
  const vars = new Set()
  for (const cmds of bySeg.values()) {
    const r = judgeStatement(cmds, names, mode, vars)
    if (Array.isArray(r)) return { rule: r[0], why: r[1] }
    if (r && r.assign) {
      const v = assignedVar(cmds)
      if (v) vars.add(v)
    }
  }
  return null
}

function check(cmd, names, mode) {
  const hit = classify(cmd, names, mode)
  return hit ? hit.why : null
}

function howToFindPid(platform) {
  if (platform === 'win32') {
    return [
      'By port: netstat -ano | findstr :<port>   (last column is the PID)',
      "By project: Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*<your project dir>*' } | select ProcessId, CommandLine",
      'Then: taskkill /PID <pid> /T /F',
    ].join('\n')
  }
  return [
    'By port: lsof -ti :<port>',
    "By project: pgrep -af '<your project dir>'",
    'Then: kill <pid>   (or kill -- -<pgid> for a process group you started)',
  ].join('\n')
}

function message(why, platform = process.platform) {
  return `[bulkhead] kill-guard: ${why}\n` +
    'Other Claude sessions, subagents and the user run these programs on this machine too. ' +
    'Killing by name takes down their dev servers, test runs and builds, and can end your own session.\n' +
    'Stop only the processes you started, by PID:\n' + howToFindPid(platform)
}

if (require.main === module) {
  runHook('kill-guard', input => {
    const cmd = input.tool_input && input.tool_input.command
    if (typeof cmd !== 'string' || !cmd) return
    const hit = classify(cmd, { allowNames: setting('killGuard.allowNames', []), extraSharedNames: setting('killGuard.extraSharedNames', []) }, shell.modeFor(input))
    if (!hit) return
    return blocked('kill-guard', hit.rule, input, message(hit.why))
  })
}

module.exports = { check, classify, message, nameHits, patternHits }
