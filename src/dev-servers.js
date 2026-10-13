'use strict'
const fs = require('fs')
const path = require('path')

// Dev servers and the port each one uses when none is given. `sub` lists the subcommands
// that start a server; '' means the bare command does, null means any arguments do.
const TOOLS = [
  { bin: ['next'], sub: ['dev', 'start'], port: 3000, flags: ['-p', '--port'], env: ['PORT'] },
  { bin: ['vite'], sub: ['', 'dev', 'serve'], port: 5173, flags: ['--port'] },
  { bin: ['vite'], sub: ['preview'], port: 4173, flags: ['--port'] },
  { bin: ['astro'], sub: ['dev', 'preview'], port: 4321, flags: ['--port'] },
  { bin: ['nuxt', 'nuxi'], sub: ['dev'], port: 3000, flags: ['-p', '--port'], env: ['NUXT_PORT', 'PORT'] },
  { bin: ['remix'], sub: ['dev'], port: 3000, flags: ['--port'], env: ['PORT'] },
  { bin: ['remix'], sub: ['vite:dev'], port: 5173, flags: ['--port'] },
  { bin: ['expo'], sub: ['start'], port: 8081, flags: ['-p', '--port'], env: ['RCT_METRO_PORT'] },
  { bin: ['uvicorn'], sub: null, port: 8000, flags: ['--port'] },
  { bin: ['flask'], sub: ['run'], port: 5000, flags: ['-p', '--port'], env: ['FLASK_RUN_PORT'] },
  { bin: ['rails'], sub: ['s', 'server'], port: 3000, flags: ['-p', '--port'], env: ['PORT'] },
  { bin: ['gatsby'], sub: ['develop'], port: 8000, flags: ['-p', '--port'] },
  { bin: ['ng'], sub: ['serve'], port: 4200, flags: ['--port'] },
  { bin: ['webpack'], sub: ['serve'], port: 8080, flags: ['--port'] },
  { bin: ['webpack-dev-server'], sub: null, port: 8080, flags: ['--port'] },
  { bin: ['hugo'], sub: ['server', 'serve'], port: 1313, flags: ['-p', '--port'] },
  { bin: ['jekyll'], sub: ['serve', 's'], port: 4000, flags: ['-P', '--port'] },
  { bin: ['storybook'], sub: ['dev'], port: 6006, flags: ['-p', '--port'] },
  { bin: ['wrangler'], sub: ['dev'], port: 8787, flags: ['--port'] },
  { bin: ['docusaurus'], sub: ['start'], port: 3000, flags: ['-p', '--port'] },
  { bin: ['http-server'], sub: null, port: 8080, flags: ['-p', '--port'] },
  // positional ports
  { bin: ['http.server'], sub: null, port: 8000, positional: /^(\d+)$/ },
  { bin: ['manage.py'], sub: ['runserver'], port: 8000, positional: /^(?:[\w.[\]]*:)?(\d+)$/ },
  { bin: ['artisan'], sub: ['serve'], port: 8000, flags: ['--port'] },
]

const WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'nohup', 'exec', 'time', 'env', 'cross-env', 'dotenv', 'sudo', 'nice'])
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

// Words of one segment. Grouping parentheses and braces, `( npm run dev )`, are not words.
function tokens(s) {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]).filter(t => !/^[(){}]$/.test(t))
}

function segments(cmd) {
  return cmd.replace(/\d?>&\d/g, ' ').split(/\n|;|&&|\|\||\||&/).map(s => s.trim()).filter(Boolean)
}

const binName = t => path.basename(String(t)).replace(/\.(?:cmd|exe|ps1)$/i, '').toLowerCase()

// Leading NAME=value pairs, `export NAME=value`, `set NAME=value` and `$env:NAME = value`.
function takeEnv(t, env) {
  let i = 0
  for (;;) {
    if (/^(?:export|set|env)$/i.test(t[i]) && /^\w+=/.test(t[i + 1] || '')) i++
    const ps = /^\$env:(\w+)(?:=(.*))?$/i.exec(t[i] || '')
    if (ps) {
      if (ps[2] !== undefined && ps[2] !== '') env[ps[1].toUpperCase()] = ps[2]
      else if (t[i + 1] === '=') { env[ps[1].toUpperCase()] = t[i + 2]; i += 2 }
      i++
      continue
    }
    const m = /^(\w+)=(.*)$/.exec(t[i] || '')
    if (!m) return i
    env[m[1].toUpperCase()] = m[2]
    i++
  }
}

// Index of the real command after npx, nohup, python -m and similar.
function commandStart(t) {
  let i = 0
  while (i < t.length) {
    const b = binName(t[i])
    if (WRAPPERS.has(b) || /^-(?:y|-yes)$/.test(t[i]) || /^\w+=/.test(t[i])) i++
    else if ((b === 'pnpm' || b === 'yarn' || b === 'npm') && /^(?:exec|dlx)$/.test(t[i + 1])) i += 2
    else if (b === 'bundle' && t[i + 1] === 'exec') i += 2
    else if (/^python[\d.]*$|^py$/.test(b) && t[i + 1] === '-m') i += 2
    else if (/^python[\d.]*$|^py$|^php$/.test(b) && /^(?:manage\.py|artisan)$/.test(binName(t[i + 1] || ''))) i += 1
    else break
  }
  return i
}

// The last port flag wins, as in `npm run dev -- -p 3001` over a script's `next dev -p 3000`.
function flagPort(args, flags = []) {
  let port
  for (let i = 0; i < args.length; i++) {
    for (const f of flags) {
      const v = args[i] === f ? args[i + 1] : args[i].startsWith(f + '=') ? args[i].slice(f.length + 1) : undefined
      if (v !== undefined) port = /^\d+$/.test(v) ? Number(v) : null
    }
  }
  return port
}

function toolPort(tool, args, env) {
  if (tool.positional) {
    const hit = args.map(a => tool.positional.exec(a)).find(Boolean)
    return hit ? Number(hit[1]) : tool.port
  }
  const flag = flagPort(args, tool.flags)
  if (flag !== undefined) return flag
  for (const name of tool.env || []) {
    if (env[name] !== undefined) return /^\d+$/.test(env[name]) ? Number(env[name]) : null
  }
  return tool.port
}

function matchTool(t, env) {
  const bin = binName(t[0] || '')
  const sub = t[1] && !t[1].startsWith('-') ? t[1] : ''
  for (const tool of TOOLS) {
    if (!tool.bin.includes(bin)) continue
    if (tool.sub && !tool.sub.includes(sub)) continue
    const argsAt = tool.sub && sub ? 2 : 1
    return { tool, argsAt, port: toolPort(tool, t.slice(argsAt), env) }
  }
  return null
}

// npm run dev, npm start, pnpm dev, yarn dev, bun run dev -> { runner, script, extra }
function scriptCall(t) {
  const runner = binName(t[0] || '')
  if (!RUNNERS.has(runner)) return null
  let i = 1
  while (/^-/.test(t[i] || '')) i += /^(?:--prefix|-C|--cwd|--dir)$/.test(t[i]) ? 2 : 1
  let script = t[i]
  if (script === 'run' || script === 'run-script') script = t[++i]
  else if (runner === 'npm' && script !== 'start') return null
  if (!script || script === 'install' || script === 'test') return null
  const extra = t.slice(i + 1).filter(a => a !== '--')
  return { runner, script, extra }
}

function prefixDir(t, dir) {
  const i = t.findIndex(a => /^(?:--prefix|-C|--cwd|--dir)$/.test(a))
  return i > 0 && t[i + 1] ? resolveDir(dir, t[i + 1]) : dir
}

function resolveDir(dir, to) {
  const win = /^\/([a-z])(?:\/|$)/i.exec(to)
  const target = process.platform === 'win32' && win ? `${win[1]}:/${to.slice(3)}` : to
  return path.resolve(dir || '.', target)
}

function readScripts(dir, readFile) {
  try {
    return JSON.parse(readFile(path.resolve(dir, 'package.json'), 'utf8')).scripts || {}
  } catch {
    return {}
  }
}

// Returns null when no known dev server starts, otherwise { port, portArg, hint } where port
// is null when it cannot be worked out and hint(n) shows how to start the same thing on port n.
function detect(cmd, { cwd = process.cwd(), readFile = fs.readFileSync, depth = 0, env = {} } = {}) {
  env = { ...env }
  let dir = cwd
  for (const seg of segments(String(cmd || ''))) {
    let t = tokens(seg)
    t = t.slice(takeEnv(t, env))
    if (!t.length) continue
    if (/^(?:cd|pushd|Set-Location|sl)$/i.test(t[0])) {
      const to = t.slice(1).find(a => !/^[/-]d$/i.test(a))
      if (to) dir = resolveDir(dir, to)
      continue
    }
    const skip = commandStart(t)
    const hit = matchTool(t.slice(skip), env)
    if (hit) {
      const flags = hit.tool.flags || []
      const portArg = n => (flags.length ? `${flags[flags.length - 1]} ${n}` : String(n))
      const kept = withoutPort(t, skip + hit.argsAt, hit.tool)
      return { port: hit.port, portArg, hint: n => [...kept.map(quote), portArg(n)].join(' ') }
    }
    const call = scriptCall(t.slice(skip))
    if (!call || depth > 2) continue
    const runDir = prefixDir(t.slice(skip), dir)
    const body = readScripts(runDir, readFile)[call.script]
    if (!body) continue
    const inner = detect([body, ...call.extra].join(' '), { cwd: runDir, readFile, depth: depth + 1, env })
    if (!inner) continue
    return { port: inner.port, portArg: inner.portArg, hint: n => `${call.runner} run ${call.script} -- ${inner.portArg(n)}` }
  }
  return null
}

const quote = a => (/[\s"]/.test(a) ? `'${a}'` : a)

// The command as typed, minus redirections and any port it already names.
function withoutPort(t, argsAt, tool) {
  const out = t.slice(0, argsAt)
  for (let i = argsAt; i < t.length; i++) {
    const a = t[i]
    if (/^\d?>/.test(a)) { if (/^\d?>>?$/.test(a)) i++; continue }
    if (tool.positional && tool.positional.test(a)) continue
    const flag = (tool.flags || []).find(f => a === f || a.startsWith(f + '='))
    if (flag) { if (a === flag) i++; continue }
    out.push(a)
  }
  return out
}

module.exports = { detect, tokens, segments, TOOLS }
