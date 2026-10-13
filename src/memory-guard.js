'use strict'
const { runHook, blocked } = require('./hook')
const { readMemory } = require('./memory')
const { limits } = require('./slots')
const shell = require('./shell')

// Commands that commonly take several GB of RAM: test runners with workers, full builds,
// bundlers, emulators and browsers. Each test gets the command's words with wrappers taken off.
const sub = argv => argv.slice(1).find(a => !a.startsWith('-')) || ''
const has = (argv, re) => argv.slice(1).some(a => re.test(a))
const quiet = argv => has(argv, /^(?:--version|-v|-V|--help|-h)$/)

// Gradle tasks that do not compile anything; any other task starts a build.
const GRADLE_LIGHT = /^(?:tasks|help|properties|dependencies|projects|wrapper|clean|init|--stop|--status|--version|-v|--help|-h|-q|--quiet|--offline)$/
const gradle = argv => argv.slice(1).some(a => !GRADLE_LIGHT.test(a) && !/^-D|^-P/.test(a))

const HEAVY_BINS = {
  vitest: argv => !quiet(argv),
  jest: argv => !quiet(argv),
  karma: argv => sub(argv) === 'start' || !sub(argv),
  playwright: argv => sub(argv) === 'test',
  cypress: argv => sub(argv) === 'run',
  gradlew: gradle,
  gradle,
  mvn: argv => has(argv, /^(?:test|package|verify|install|deploy|integration-test)$/),
  mvnw: argv => has(argv, /^(?:test|package|verify|install|deploy|integration-test)$/),
  emulator: argv => has(argv, /^(?:-avd|@.+)$/),
  dotnet: argv => /^(?:build|test|publish)$/.test(sub(argv)),
  next: argv => /^(?:build|dev)$/.test(sub(argv)),
  vite: argv => sub(argv) === 'build',
  tsc: argv => !quiet(argv) && !has(argv, /^--init$/),
  webpack: argv => !quiet(argv) && sub(argv) !== 'serve',
  ffmpeg: argv => !quiet(argv) && argv.length > 1,
  cargo: argv => /^(?:build|b|test|t|bench)$/.test(sub(argv)),
  go: argv => sub(argv) === 'test' && has(argv, /\/\.\.\.$|^\.\.\.$/),
  pytest: argv => has(argv, /^(?:-n\d*|--numprocesses(?:=.*)?)$/),
  docker: argv => /^(?:build|buildx)$/.test(sub(argv)) || (sub(argv) === 'compose' && has(argv, /^(?:up|build)$/)),
  'docker-compose': argv => has(argv, /^(?:up|build)$/),
  bazel: argv => /^(?:build|test|run)$/.test(sub(argv)),
  turbo: argv => has(argv, /^(?:build|test)$/),
  nx: argv => /^(?:build|test|run-many|affected)$/.test(sub(argv)),
}
const RUNNERS = /^(?:npm|pnpm|yarn|bun)$/
// npx vitest, pnpm exec jest, yarn dlx, bunx, python -m pytest, node node_modules/.bin/jest
function realCommand(argv) {
  for (let guard = 0; guard < 8 && argv.length; guard++) {
    const b = shell.bin(argv[0])
    if (/^(?:npx|bunx|pnpx)$/.test(b)) {
      const at = argv.findIndex((a, k) => k > 0 && !a.startsWith('-'))
      argv = at > 0 ? argv.slice(at) : []
    } else if (RUNNERS.test(b) && /^(?:exec|dlx|x)$/.test(argv[1])) argv = argv.slice(2)
    else if (/^python[\d.]*$|^py$/.test(b) && argv[1] === '-m' && argv[2]) argv = argv.slice(2)
    else if (b === 'node' && argv[1] && /node_modules[\\/]/.test(argv[1])) argv = argv.slice(1)
    else break
  }
  return argv
}

function heavyArgv(argv) {
  argv = realCommand(argv)
  if (!argv.length) return false
  const b = shell.bin(argv[0])
  if (HEAVY_BINS[b]) return HEAVY_BINS[b](argv)
  // npm test, npm run build, pnpm build, yarn e2e, bun test
  if (RUNNERS.test(b)) {
    let k = 1
    while (argv[k] && argv[k].startsWith('-')) k += /^(?:--prefix|-C|--cwd|--dir|--filter|-F|-w|--workspace)$/.test(argv[k]) ? 2 : 1
    let script = argv[k] || ''
    if (script === 'run' || script === 'run-script') script = argv[k + 1] || ''
    return /^(?:build|test|t|e2e)(?:$|[:-])/.test(script)
  }
  return false
}

// A browser launched from code: chromium.launch(), puppeteer.launch(), launchPersistentContext.
const LAUNCH = /\b(?:chromium|firefox|webkit|puppeteer)\.launch\b|\blaunchPersistentContext\b/

// Commands that only read or search text: grep -rn vitest package.json
const INERT = /^(?:git|grep|egrep|rg|ag|echo|printf|cat|less|head|tail|ls|find|which|where|type|select-string|get-content|gc|write-host|write-output)$/i

function isHeavy(cmd, mode = 'sh') {
  const text = shell.prepare(String(cmd || ''), mode)
  for (const c of shell.commands(text, mode)) {
    const b = shell.bin(c.argv[0])
    if (INERT.test(b) || c.remote) continue
    if (/^bulkhead(?:-slot)?$/.test(b)) continue
    if (heavyArgv(c.argv)) return true
    if (LAUNCH.test(c.argv.join(' '))) return true
  }
  return false
}

const SLOT_FILE = /bulkhead[\\/]+slots|slot-\d+\.json/i
const WRITES = /(?:>{1,2}\|?|\b(?:touch|rm|del|unlink|mv|cp|Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Clear-Content|Move-Item|Copy-Item|writeFileSync|unlinkSync|rmSync|utimesSync)\b)/i

// Hand-editing slot files is how a forgotten background loop kept a slot for hours.
function touchesSlotFiles(cmd) {
  // 2>/dev/null and 2>&1 only redirect error output; they write nothing to the slot files
  const quietRedirects = String(cmd).replace(/\d?>&\d|\d?>\s*(?:\/dev\/null|\$null|nul)\b/gi, ' ')
  return quietRedirects.split(/\n|;|&&|\|\|/).some(s => SLOT_FILE.test(s) && WRITES.test(s))
}

// A command that runs through bulkhead-slot already waits for room.
function queued(cmd) {
  return /\bbulkhead(?:-|\s+)slot\b/.test(String(cmd).replace(/'[^']*'|"[^"]*"/g, ' '))
}

// With a remote configured, the block also offers running the command there (docs/remote.md).
function hasRemote() {
  try {
    return Object.keys(require('./config').get('remotes') || {}).length > 0
  } catch {
    return false
  }
}

function check(cmd, memory = () => readMemory(), minFreeGb, mode = 'sh', remote = hasRemote) {
  if (!cmd) return null
  if (touchesSlotFiles(cmd)) {
    return '[bulkhead] memory-guard: slot files are managed by bulkhead-slot. Do not write, touch or delete them by hand; ' +
      'use `bulkhead-slot run --gb=N -- <command>`, which releases its slot when the command exits. `bulkhead-slot status` shows the holders.'
  }
  if (queued(cmd) || !isHeavy(cmd, mode)) return null
  const { freeGb, totalGb } = memory()
  if (minFreeGb == null) minFreeGb = limits(totalGb).minFreeGb
  if (freeGb >= minFreeGb) return null
  return `[bulkhead] memory-guard: only ${freeGb.toFixed(1)} GB of RAM is free (minimum ${minFreeGb} GB) and this looks like a heavy command.\n` +
    'Other sessions are probably building or testing right now. Starting more work at this point is how machines freeze.\n' +
    'Either wait a minute and retry with fewer workers (for example --maxWorkers=2), or queue it:\n' +
    '  bulkhead-slot run --gb=3 -- <command>\n' +
    'bulkhead-slot waits until there is room, runs the command, and frees the slot when it exits.' +
    (remote() ? '\nOr run it on another machine, so it uses that machine\'s RAM:\n  bulkhead remote run -- <command>' : '')
}

if (require.main === module) {
  runHook('memory-guard', input => {
    const cmd = input.tool_input && input.tool_input.command
    if (typeof cmd !== 'string') return
    const why = check(cmd, undefined, undefined, shell.modeFor(input))
    if (!why) return
    return blocked('memory-guard', touchesSlotFiles(cmd) ? 'slot-files' : 'low-memory', input, why)
  })
}

module.exports = { check, isHeavy, touchesSlotFiles }
