'use strict'
// Shell parsing shared by the guards.
//
//   lex(text, mode)        words and simple commands, quote aware, with $( ) and backticks
//   commands(text, mode)   the simple commands a line runs, wrappers taken off (sudo, env,
//                          VAR=value, nohup, time, nice, xargs, timeout) and shell wrappers
//                          opened (bash -c, sh -c, powershell -Command, cmd /c, eval), up to
//                          three levels deep
//   unwrap(text, mode)     the same text with each shell wrapper replaced by ( inner command )
//   prepare(text, mode)    the text without what is never executed: heredocs written to files
//                          or handed to git and gh, and git and gh message arguments
//
// mode is 'sh' (Bash tool), 'ps' (PowerShell tool) or 'cmd' (inside cmd /c). Every function is
// linear in the length of its input: no regular expression here can backtrack across the text.

const MAX_DEPTH = 3

// The program name of a command word: no directory, no Windows extension, lower case. Guards ask
// this many times per command, so short words are cached. A word of thousands of characters is
// not a program name, and reading it again for every check would cost a pass over it each time.
const BIN_CACHE = new Map()
function bin(v) {
  const s = String(v)
  if (s.length > 4096) return ''
  let r = BIN_CACHE.get(s)
  if (r !== undefined) return r
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  r = (cut >= 0 ? s.slice(cut + 1) : s).replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase()
  if (BIN_CACHE.size >= 4096) BIN_CACHE.clear()
  BIN_CACHE.set(s, r)
  return r
}

// ---------------------------------------------------------------------------------------------
// Lexer

// In the sh mode an unquoted backslash escapes only these; elsewhere it stays, so C:\Users survives.
const SH_ESCAPABLE = new Set([' ', '\t', '"', "'", '\\', '$', '`', ';', '&', '|', '(', ')', '<', '>'])
const LOOP_OPEN = new Set(['for', 'while', 'until', 'select', 'if', 'case'])
const LOOP_CLOSE = new Set(['done', 'fi', 'esac'])
// separators that end a statement; a pipe keeps the statement going
const STATEMENT_OPS = new Set([';', '\n', '&&', '||', '&'])

// Returns { cmds, unterminated }. Each command is { words, s, e, seg, sub }: words are
// { v (value, quotes removed), s, e (raw offsets), q (some part was quoted) }, seg numbers the
// top-level statement the command belongs to (a loop or a { } block is one statement), and sub
// is true inside $( ), backticks or <( ).
function lex(src, mode = 'sh') {
  src = String(src)
  const ps = mode === 'ps'
  const cmd = mode === 'cmd'
  const cmds = []
  let unterminated = false
  let seg = 0
  let depth = 0 // loops, if blocks and braces at the top level
  const stack = []
  const frame = (kind, start) => ({ kind, start, words: [], word: null, quote: null, paren: 0, wordParen: 0 })
  let f = frame('top', 0)

  const startWord = i => { if (!f.word) f.word = { v: '', s: i, e: i, q: false } }
  const endWord = i => {
    const w = f.word
    if (!w) return
    w.e = i
    if (f.kind === 'top' && !ps && !w.q && f.words.length === 0) {
      if (LOOP_OPEN.has(w.v)) depth++
      else if (LOOP_CLOSE.has(w.v)) depth = Math.max(0, depth - 1)
    }
    f.words.push(w)
    f.word = null
    f.wordParen = 0
  }
  const endCmd = () => {
    if (f.words.length) {
      const ws = f.words
      cmds.push({ words: ws, s: ws[0].s, e: ws[ws.length - 1].e, seg, sub: f.kind !== 'top' })
    }
    f.words = []
  }
  const op = (i, o) => {
    endWord(i)
    endCmd()
    if (f.kind === 'top' && depth === 0 && STATEMENT_OPS.has(o)) seg++
  }
  // Each closing $( ) copies its text into the word around it, so nesting is capped: past 16
  // levels, which no real command reaches, $( is read as plain text and the copying stays linear.
  const push = (kind, at) => {
    if (stack.length >= 16) return false
    stack.push(f)
    f = frame(kind, at)
    return true
  }
  const pop = i => {
    endWord(i)
    endCmd()
    const inner = f
    f = stack.pop()
    f.word.v += src.slice(inner.start, i + 1)
  }
  // braces and parentheses group statements: `{ a; b; }`, `(cd web && x)`
  const brace = c => {
    if (f.kind !== 'top') return
    if (c === '{' || c === '(') depth++
    else if (c === '}' || c === ')') depth = Math.max(0, depth - 1)
  }

  const n = src.length
  for (let i = 0; i < n; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (f.quote === "'") {
      if (c === "'") {
        if (ps && next === "'") { f.word.v += "'"; i++ } else f.quote = null
      } else f.word.v += c
      continue
    }
    if (f.quote === '"') {
      if (!ps && !cmd && c === '\\' && (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n')) {
        if (next !== '\n') f.word.v += next
        i++
      } else if (ps && c === '`' && next !== undefined) {
        f.word.v += next
        i++
      } else if (c === '"') {
        if (ps && next === '"') { f.word.v += '"'; i++ } else f.quote = null
      } else if (!cmd && c === '$' && next === '(') {
        if (!push('sub', i)) f.word.v += '$('
        i++
      } else if (!ps && !cmd && c === '`') {
        if (!push('bt', i)) f.word.v += c
      } else f.word.v += c
      continue
    }
    // unquoted
    if (f.kind === 'bt' && c === '`') { pop(i); continue }
    if (f.kind === 'sub' && c === ')' && f.paren === 0 && f.wordParen === 0) { pop(i); continue }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { endWord(i); continue }
    if (c === '\n' || c === ';') { op(i, c); continue }
    if (c === '&') {
      if (next === '&') { op(i, '&&'); i++; continue }
      const prev = f.word ? src[i - 1] : ''
      if (prev === '>' || prev === '<' || next === '>') { startWord(i); f.word.v += c; continue }
      op(i, '&')
      continue
    }
    if (c === '|') {
      const prev = f.word ? src[i - 1] : ''
      if (prev === '>') { f.word.v += c; continue }
      if (next === '|') { op(i, '||'); i++; continue }
      if (next === '&') { op(i, '|'); i++; continue }
      op(i, '|')
      continue
    }
    if (cmd && c === '^' && next !== undefined) { startWord(i); f.word.v += next; i++; continue }
    if (ps && c === '`' && next !== undefined) {
      if (next === '\n' || next === '\r') { i++; continue }
      startWord(i)
      f.word.v += next
      i++
      continue
    }
    if (!ps && !cmd && c === '\\') {
      if (next === '\n') { endWord(i); i++; continue }
      startWord(i)
      if (next !== undefined && SH_ESCAPABLE.has(next)) { f.word.v += next; i++ } else f.word.v += c
      continue
    }
    if (c === '(') {
      if (f.word) {
        // the raw previous character: reading the end of a word built by += would flatten it every time
        const prev = src[i - 1]
        if (!cmd && (prev === '<' || prev === '>') && i - f.word.s <= 2 && push('sub', i)) continue
        f.word.v += c
        f.wordParen++
        continue
      }
      op(i, '(')
      f.paren++
      brace(c)
      continue
    }
    if (c === ')') {
      if (f.word && f.wordParen > 0) { f.word.v += c; f.wordParen--; continue }
      op(i, ')')
      f.paren = Math.max(0, f.paren - 1)
      brace(c)
      continue
    }
    if (!cmd && c === '$' && next === '(') {
      startWord(i)
      if (!push('sub', i)) f.word.v += '$('
      i++
      continue
    }
    if (!ps && !cmd && c === '`') {
      startWord(i)
      if (!push('bt', i)) f.word.v += c
      continue
    }
    if (c === '#' && !f.word && !cmd) {
      const nl = src.indexOf('\n', i)
      i = (nl < 0 ? n : nl) - 1
      continue
    }
    if ((c === '"' || (c === "'" && !cmd))) {
      startWord(i)
      f.word.q = true
      f.quote = c
      continue
    }
    if (c === '{' || c === '}') brace(c)
    startWord(i)
    f.word.v += c
  }
  for (;;) {
    if (f.quote || f.kind !== 'top') unterminated = true
    if (f.kind === 'top') break
    pop(n - 1)
  }
  endWord(n)
  endCmd()
  return { cmds, unterminated }
}

// ---------------------------------------------------------------------------------------------
// Wrappers

const RESERVED = new Set(['!', '{', '}', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', 'builtin', 'noglob', 'nocorrect'])
const SUDO_VALUE = new Set(['-u', '-g', '-p', '-C', '-h', '-U', '-r', '-t', '-D', '-R', '-T', '--user', '--group', '--prompt', '--close-from', '--host', '--other-user', '--role', '--type', '--chdir', '--chroot', '--command-timeout'])
const XARGS_VALUE = new Set(['-I', '-n', '-P', '-L', '-l', '-s', '-d', '-E', '-e', '-a', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--delimiter', '--eof', '--arg-file', '--replace'])
const TIMEOUT_VALUE = new Set(['-s', '-k', '--signal', '--kill-after'])
const ENV_VALUE = new Set(['-u', '-C', '--unset', '--chdir'])
const NICE_VALUE = new Set(['-n', '--adjustment'])
const IONICE_VALUE = new Set(['-c', '-n', '--class', '--classdata'])
const STDBUF_VALUE = new Set(['-i', '-o', '-e'])
const WATCH_VALUE = new Set(['-n', '--interval', '-q', '--equexit'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish'])
const SHELL_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])

// Index of the first word at or after k that is not an option. `--` ends the options.
function skipOptions(words, k, valued = new Set()) {
  while (k < words.length) {
    const v = words[k].v
    if (v === '--') return k + 1
    if (!/^[-+]./.test(v) || words[k].q) return k
    k += valued.has(v) ? 2 : 1
  }
  return k
}

// Programs whose arguments run on another machine or in a container: the kill, checkout and
// delete guards look after this machine only.
function isRemote(argv) {
  const b = bin(argv[0].v)
  if (b === 'ssh' || b === 'autossh' || b === 'mosh') return true
  // bulkhead remote run sends its command to another machine
  if (b === 'bulkhead' && argv[1] && argv[1].v === 'remote') return true
  const sub = argv.slice(1, 5).map(w => w.v)
  if (/^(?:docker|podman|nerdctl|docker-compose|kubectl|oc|lxc|incus)$/.test(b)) return sub.includes('exec') || sub.includes('run') || sub.includes('debug')
  if (b === 'vagrant' || b === 'gcloud' || b === 'az' || b === 'fly' || b === 'flyctl') return sub.includes('ssh')
  if (b === 'heroku') return sub.includes('run')
  return false
}

// UTF-16LE base64, as powershell -EncodedCommand takes it.
function decodeEncoded(s) {
  try {
    const out = Buffer.from(s, 'base64').toString('utf16le')
    return /[\x20-\x7e]/.test(out) ? out : null
  } catch {
    return null
  }
}

function rawFrom(src, words, k) {
  return k < words.length ? src.slice(words[k].s, words[words.length - 1].e) : ''
}

const SSH_VALUE = new Set(['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B', '-I'])
const EXEC_VALUE = new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file', '--detach-keys', '-c', '--container', '-n', '--namespace', '--index'])

// The command ssh, docker exec or kubectl exec runs on the other side: { text, mode } or null.
function remoteInner(src, argv) {
  const b = bin(argv[0].v)
  const vals = argv.map(w => w.v)
  let k
  if (b === 'ssh') {
    k = skipOptions(argv, 1, SSH_VALUE) + 1
  } else if (b === 'bulkhead') {
    // bulkhead remote run [options] -- <command>: this side waits for it like ssh does
    const dash = vals.indexOf('--')
    if (dash < 0) return null
    k = dash + 1
  } else {
    const at = vals.indexOf('exec')
    if (at < 1 || at > 3) return null
    const dash = vals.indexOf('--', at)
    if (vals.some(v => v === '-d' || v === '--detach')) return null
    if (dash > 0) k = dash + 1
    else if (b === 'kubectl' || b === 'oc') return null
    else k = skipOptions(argv, at + 1, EXEC_VALUE) + 1
  }
  if (k >= argv.length) return null
  return { text: k === argv.length - 1 ? vals[k] : rawFrom(src, argv, k), mode: 'sh' }
}

// The inner command of a shell wrapper: { text, mode } or null.
function innerOf(src, argv, mode) {
  const b = bin(argv[0].v)
  const vals = argv.map(w => w.v)
  if (SHELLS.has(b) || (b === 'busybox' && SHELLS.has(bin(vals[1] || '')))) {
    let k = b === 'busybox' ? 2 : 1
    let c = false
    while (k < argv.length && /^[-+]/.test(vals[k]) && !argv[k].q) {
      const v = vals[k]
      if (v === '--' || v === '-') { k++; break }
      if (/^-[a-zA-Z]+$/.test(v) && v.includes('c')) c = true
      else if (v === '--command') c = true
      k += SHELL_VALUE.has(v) ? 2 : 1
    }
    return c && k < argv.length ? { text: vals[k], mode: 'sh' } : null
  }
  if (b === 'powershell' || b === 'pwsh' || b === 'powershell_ise') {
    for (let k = 1; k < argv.length; k++) {
      const v = vals[k].toLowerCase()
      if (!v.startsWith('-') || argv[k].q) {
        if (/\.ps1$/i.test(vals[k])) return null
        return { text: vals.slice(k).join(' '), mode: 'ps' }
      }
      if (/^-(?:c|co|com|comm|comma|comman|command)$/.test(v)) {
        const rest = vals.slice(k + 1)
        if (!rest.length || rest[0] === '-') return null
        return { text: rest.join(' '), mode: 'ps' }
      }
      if (/^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/.test(v)) {
        const text = decodeEncoded(vals[k + 1] || '')
        return text ? { text, mode: 'ps' } : null
      }
      if (/^-(?:f|fi|fil|file)$/.test(v)) return null
      if (/^-(?:ex|ep|executionpolicy|w|win|windowstyle|wd|workingdirectory|configurationname|of|outputformat|if|inputformat|v|version|psconsolefile|custompipename|settingsfile)$/.test(v)) k++
    }
    return null
  }
  if (b === 'cmd') {
    for (let k = 1; k < argv.length; k++) {
      const v = vals[k].toLowerCase()
      if (/^\/\/?[ck]$/.test(v)) {
        let text = rawFrom(src, argv, k + 1)
        if (text.length > 1 && text[0] === '"' && text[text.length - 1] === '"') text = text.slice(1, -1)
        return text ? { text, mode: 'cmd' } : null
      }
      if (!/^\/\/?[a-z](?::\w+)?$/.test(v)) return null
    }
    return null
  }
  if (b === 'eval' && argv.length > 1) return { text: vals.slice(1).join(' '), mode }
  if (b === 'trap' && argv.length > 1 && vals[1] !== '-' && !vals[1].startsWith('-')) return { text: vals[1], mode }
  if (b === 'watch') {
    const k = skipOptions(argv, 1, WATCH_VALUE)
    return k < argv.length ? { text: vals.slice(k).join(' '), mode } : null
  }
  if (b === 'su') {
    const i = vals.findIndex((v, j) => j > 0 && (v === '-c' || v === '--command'))
    if (i > 0 && vals[i + 1]) return { text: vals[i + 1], mode: 'sh' }
    const eq = vals.find(v => v.startsWith('--command='))
    return eq ? { text: eq.slice(10), mode: 'sh' } : null
  }
  if (b === 'env') {
    const i = vals.findIndex((v, j) => j > 0 && (v === '-S' || v === '--split-string'))
    if (i > 0 && vals[i + 1]) return { text: vals.slice(i + 1).join(' '), mode: 'sh' }
  }
  if (b === 'start-process' || b === 'saps' || (b === 'start' && mode === 'ps')) {
    let file = null
    let args = null
    const pos = []
    for (let k = 1; k < argv.length; k++) {
      const v = vals[k].toLowerCase()
      if (!argv[k].q && /^-(?:filepath|fi|file|path)$/.test(v)) file = vals[++k]
      else if (!argv[k].q && /^-(?:argumentlist|args|arguments|a)$/.test(v)) args = vals[++k]
      else if (!argv[k].q && v.startsWith('-')) {
        if (/^-(?:workingdirectory|wo|redirectstandard\w*|verb|windowstyle|credential|wait)$/.test(v) && !/^-wait$/.test(v)) k++
      } else pos.push(vals[k])
    }
    file = file || pos[0]
    args = args || pos[1] || ''
    return file ? { text: `${file} ${String(args).replace(/,/g, ' ')}`.trim(), mode: 'cmd' } : null
  }
  return null
}

// Takes leading wrappers off a command's words. Returns { argv, inner, remote, at }.
function strip(src, words, mode) {
  let k = 0
  for (let guard = 0; k < words.length && guard < 64; guard++) {
    const w = words[k]
    const v = w.v
    if (!w.q && RESERVED.has(v)) { k++; continue }
    if (!w.q && /^[A-Za-z_]\w*\+?=/.test(v)) { k++; continue }
    const b = bin(v)
    if (b === 'sudo' || b === 'doas' || b === 'run0') { k = skipOptions(words, k + 1, SUDO_VALUE); continue }
    if (b === 'nohup' || b === 'unbuffer' || b === 'setsid' || b === 'caffeinate' || b === 'cross-env' || b === 'chronic') { k = skipOptions(words, k + 1); continue }
    if (b === 'exec' || b === 'time') { k = skipOptions(words, k + 1, new Set(['-a'])); continue }
    if (b === 'command') {
      if (words[k + 1] && /^-[a-zA-Z]*[vV]/.test(words[k + 1].v)) return { argv: [], inner: null, remote: false }
      k = skipOptions(words, k + 1)
      continue
    }
    if (b === 'nice') { k = skipOptions(words, k + 1, NICE_VALUE); continue }
    if (b === 'ionice') { k = skipOptions(words, k + 1, IONICE_VALUE); continue }
    if (b === 'stdbuf') { k = skipOptions(words, k + 1, STDBUF_VALUE); continue }
    if (b === 'timeout' || b === 'gtimeout') {
      const j = skipOptions(words, k + 1, TIMEOUT_VALUE)
      if (words[j] && /^\d/.test(words[j].v)) { k = j + 1; continue }
      break
    }
    if (b === 'env') {
      const j = skipOptions(words, k + 1, ENV_VALUE)
      let split = false
      for (let x = k + 1; x < j; x++) if (words[x].v === '-S' || words[x].v === '--split-string') split = true
      if (split) break
      k = j
      continue
    }
    if (b === 'xargs') { k = skipOptions(words, k + 1, XARGS_VALUE); continue }
    break
  }
  const argv = words.slice(k)
  if (!argv.length) return { argv, inner: null, remote: false }
  if (isRemote(argv)) return { argv, inner: null, remote: true }
  return { argv, inner: innerOf(src, argv, mode), remote: false }
}

// Quick test before lexing for wrappers: most commands have none.
const WRAPPER_HINT = /(?:^|[^\w-])(?:bash|sh|zsh|dash|ksh|ash|mksh|fish|busybox|powershell|pwsh|powershell_ise|cmd|eval|trap|watch|su|env|Start-Process|saps|start)(?:\.exe)?(?![\w-])/i
const REMOTE_HINT = /(?:^|[^\w-])(?:ssh|docker|podman|nerdctl|kubectl|oc|bulkhead)(?:\.exe)?(?![\w-])/i

// Every simple command the text runs, with wrappers taken off and shell wrappers opened.
// Each item is { argv, words, remote, depth, sub }.
function commands(src, mode = 'sh', depth = 0, out = []) {
  src = String(src || '')
  const { cmds, unterminated } = lex(src, mode)
  collect(src, cmds, mode, depth, out)
  // A quote that never closes is a syntax error for the shell, which then runs nothing. Read it
  // once more without quotes so a stray apostrophe cannot hide a command.
  if (unterminated && depth === 0) collect(src, lex(src.replace(/["'`]/g, ' '), mode).cmds, mode, depth, out)
  return out
}

function collect(src, cmds, mode, depth, out) {
  for (const c of cmds) {
    const s = strip(src, c.words, mode)
    if (s.inner && depth < MAX_DEPTH) {
      commands(s.inner.text, s.inner.mode, depth + 1, out)
      continue
    }
    if (s.argv.length) out.push({ argv: s.argv.map(w => w.v), words: s.argv, remote: s.remote, depth, sub: c.sub, seg: c.seg, s: c.s, e: c.e })
  }
}

// The text with each shell wrapper replaced by ( inner command ), recursively. Prefixes such as
// timeout 60 stay, so a guard still sees them. Returns the input when there is nothing to open.
// With remote: true, the command ssh, docker exec or kubectl exec runs is opened too: it runs
// elsewhere, but the session still waits for it.
function unwrap(src, mode = 'sh', depth = 0, { remote = false } = {}) {
  src = String(src || '')
  if (depth >= MAX_DEPTH || !(WRAPPER_HINT.test(src) || (remote && REMOTE_HINT.test(src)))) return src
  // commands inside $( ) end before the command around them, so put them in text order
  const cmds = lex(src, mode).cmds.sort((a, b) => a.s - b.s)
  const parts = []
  let last = 0
  for (const c of cmds) {
    if (c.s < last) continue
    const s = strip(src, c.words, mode)
    const inner = s.inner || (remote && s.remote ? remoteInner(src, s.argv) : null)
    if (!inner) continue
    const from = s.argv[0].s
    parts.push(src.slice(last, from), `( ${unwrap(inner.text, inner.mode, depth + 1, { remote })} )`)
    last = c.e
  }
  if (!parts.length) return src
  parts.push(src.slice(last))
  return parts.join('')
}

// ---------------------------------------------------------------------------------------------
// Text that is never executed

const EXEC_WORDS = /(?:^|[\s;&|(`"$])(?:bash|sh|zsh|eval|source|pwsh|powershell|python[\d.]*|py|node|deno|bun|ruby|perl|php|osascript)(?:\.exe)?(?=[\s"')]|$)/
const MESSAGE_TOOLS = new Set(['git', 'gh', 'glab', 'hub', 'hg', 'svn', 'jj', 'tea'])
const MESSAGE_FLAGS = /^(?:-m|--message|--title|--body|--notes|--description|--subject|--comment|-[a-z]*m)$/
const GH_SHORT = /^-[tbd]$/

// Heredocs whose body is never run: written to a file by cat or tee, printed by cat, or handed
// to git and gh as a message (git commit -F -, gh pr create --body-file -). The opener line
// stays; the body and terminator go. A tag is searched for once, so missing terminators cost
// one pass in total.
function stripHeredocs(src) {
  const docs = heredocs(src, heredocNotRun)
  if (!docs.length) return src
  let out = ''
  let last = 0
  for (const d of docs) {
    out += src.slice(last, d.start) + ' ' + d.rest
    last = d.end
  }
  return out + src.slice(last)
}

// Heredocs for which want(prefix, after) holds, in order: { start, end, prefix, rest, body }.
// prefix is the opener line before <<TAG (at most 300 characters), rest the line after it.
// A heredoc whose terminator never comes is left alone. Linear: each tag's terminator is
// searched for once, and the line-start search never leaves a 300-character window.
function heredocs(src, want) {
  const out = []
  if (src.indexOf('<<') < 0) return out
  const opener = /<<(-?)[ \t]*(['"]?)([\w.-]+)\2/g
  let lines = null
  const missing = new Set()
  let last = 0
  let lineEnd = -1
  let m
  while ((m = opener.exec(src))) {
    if (src[m.index - 1] === '<' || src[m.index + 2] === '<') continue
    const tag = m[3]
    if (missing.has(tag)) continue
    const win = src.slice(Math.max(last, m.index - 300), m.index)
    const prefix = win.slice(win.lastIndexOf('\n') + 1)
    if (lineEnd < m.index) {
      lineEnd = src.indexOf('\n', m.index)
      if (lineEnd < 0) lineEnd = src.length
    }
    const after = src.slice(m.index + m[0].length, Math.min(lineEnd, m.index + m[0].length + 300))
    if (!want(prefix, after)) continue
    if (!lines) lines = new Set(src.split('\n').map(l => l.trim()))
    if (!lines.has(tag)) { missing.add(tag); continue }
    const end = new RegExp(`\\n[ \\t]*${tag.replace(/[.]/g, '\\.')}[ \\t]*(?=\\r?\\n|$)`, 'g')
    end.lastIndex = lineEnd
    const e = lineEnd < src.length ? end.exec(src) : null
    if (!e) { missing.add(tag); continue }
    out.push({ start: m.index, end: e.index + e[0].length, prefix, rest: src.slice(m.index + m[0].length, lineEnd), body: src.slice(lineEnd + 1, e.index) })
    last = opener.lastIndex = e.index + e[0].length
    lineEnd = -1
  }
  return out
}

function heredocNotRun(prefix, after) {
  if (EXEC_WORDS.test(prefix)) return false
  const piped = after.indexOf('|') >= 0 && !/\|\s*(?:gh|git|glab|tee|cat)\b/.test(after)
  if (/(?:^|[\s;&|(`"])(?:cat|tee)\b[^|]*$/.test(prefix)) return !piped
  return /(?:^|[\s;&|(`"$])(?:git|gh|glab)\b/.test(prefix)
}

// The quoted text after -m, --message, --title, --body, --notes in git, gh and similar commands
// becomes '' so its words never look like a command.
function stripMessages(src, mode) {
  if (!/\b(?:git|gh|glab|hub|hg|svn|jj|tea)\b/i.test(src)) return src
  const { cmds } = lex(src, mode)
  const cut = []
  for (const c of cmds) {
    const s = strip(src, c.words, mode)
    if (!s.argv.length || !MESSAGE_TOOLS.has(bin(s.argv[0].v))) continue
    const gh = /^(?:gh|glab|tea)$/.test(bin(s.argv[0].v))
    const ws = s.argv
    for (let k = 1; k < ws.length; k++) {
      const v = ws[k].v
      const eq = /^(--(?:message|title|body|notes|description|subject|comment))=/.exec(v)
      if (eq && ws[k].q) { cut.push([ws[k].s, ws[k].e, eq[0] + "''"]); continue }
      if ((MESSAGE_FLAGS.test(v) || (gh && GH_SHORT.test(v))) && !ws[k].q && ws[k + 1] && (ws[k + 1].q || ws[k + 1].v.includes('$('))) {
        cut.push([ws[k + 1].s, ws[k + 1].e, "''"])
        k++
      }
    }
  }
  if (!cut.length) return src
  cut.sort((a, b) => a[0] - b[0])
  let out = ''
  let last = 0
  for (const [s, e, r] of cut) {
    if (s < last) continue
    out += src.slice(last, s) + r
    last = e
  }
  return out + src.slice(last)
}

function prepare(src, mode = 'sh') {
  return stripMessages(stripHeredocs(String(src || '')), mode)
}

// The lexer mode for a hook payload's tool.
function modeFor(input) {
  const tool = input && input.tool_name
  return /powershell/i.test(String(tool || '')) ? 'ps' : 'sh'
}

module.exports = { lex, commands, unwrap, prepare, stripHeredocs, stripMessages, heredocs, strip, bin, modeFor, skipOptions, MAX_DEPTH }
