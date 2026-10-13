'use strict'
// Runs test/corpus/allow.txt and test/corpus/block.txt through the real hook scripts.
// Every allow line goes through every PreToolUse guard and must exit 0; every block line
// goes through its tagged guard and must exit 2. Each line is its own subtest, named
// after its file and line number, so a failure points straight at the command.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const H = require('./corpus/harness')

const ALLOW = path.join(__dirname, 'corpus', 'allow.txt')
const BLOCK = path.join(__dirname, 'corpus', 'block.txt')

// The machine state each guard's must-block lines run in (see the header of block.txt).
const BLOCK_STATE = {
  'kill-guard': 'quiet',
  'wait-guard': 'quiet',
  'memory-guard': 'low-ram',
  'port-guard': 'busy-ports',
  'checkout-guard': 'shared-tree',
  basics: 'dirty',
}

const firstLine = s => (String(s).trim().split('\n')[0] || '').slice(0, 200)
const show = cmd => JSON.stringify(cmd).slice(1, -1).slice(0, 160)

let ctx
function setup() {
  if (ctx) return ctx
  const repos = { cleanRepo: H.makeRepo(), dirtyRepo: H.makeRepo({ dirty: true }) }
  const stateDir = H.realTemp('bulkhead-corpus-state-')
  const configDir = H.realTemp('bulkhead-corpus-config-')
  fs.mkdirSync(path.join(configDir, 'sessions'))
  ctx = { repos, stateDir, configDir, configStates: new Map(), temp: [repos.cleanRepo, repos.dirtyRepo, stateDir, configDir] }
  return ctx
}

test.after(() => {
  if (!ctx) return
  for (const dir of ctx.temp) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

// A state directory whose config.json is `config` (a JSON string), one per distinct config.
function stateDirFor(config) {
  const c = setup()
  if (!config) return c.stateDir
  if (!c.configStates.has(config)) {
    const dir = H.realTemp('bulkhead-corpus-state-')
    fs.writeFileSync(path.join(dir, 'config.json'), config)
    c.configStates.set(config, dir)
    c.temp.push(dir)
  }
  return c.configStates.get(config)
}

function run(guard, command, { state, tool, timeout, config }) {
  const { repos, configDir } = setup()
  const s = H.stateFor(state, repos)
  const input = H.payload(command, { cwd: s.cwd, tool, timeout })
  return H.runHook(guard, input, { cwd: s.cwd, memory: s.memory, mock: s.mock, stateDir: stateDirFor(config), configDir })
}

function crashed(r) {
  return !(r.status === 0 || r.status === 2) || H.CRASH.test(r.stderr) || H.CRASH.test(r.stdout)
}

test('corpus sizes', () => {
  const allow = H.readCorpus(ALLOW)
  const block = H.readCorpus(BLOCK)
  assert.ok(allow.length >= 600, `allow.txt has ${allow.length} commands, want at least 600`)
  assert.ok(block.length >= 150, `block.txt has ${block.length} commands, want at least 150`)
  const tags = new Set(block.map(e => e.raw.split('\t')[0].split(',')[0]))
  for (const g of H.GUARDS) assert.ok(tags.has(g), `block.txt has no line for ${g}`)
  for (const t of tags) assert.ok(H.GUARDS.includes(t), `block.txt names an unknown guard: ${t}`)
})

test('allow corpus: every guard lets ordinary commands through', { timeout: 900000 }, async t => {
  const entries = H.readCorpus(ALLOW)
  const jobs = []
  for (const e of entries) {
    for (const guard of H.GUARDS) {
      jobs.push(() => run(guard, H.decode(e.raw), { state: e.state || 'quiet', tool: e.tool, timeout: e.timeout || 120000, config: e.config }).then(r => ({ e, guard, r })))
    }
  }
  const results = await H.pool(jobs)
  const byLine = new Map()
  for (const x of results) {
    if (!byLine.has(x.e)) byLine.set(x.e, [])
    byLine.get(x.e).push(x)
  }
  const fp = Object.fromEntries(H.GUARDS.map(g => [g, 0]))
  for (const [e, rs] of byLine) {
    const bad = rs.filter(x => x.r.status !== 0)
    for (const x of bad) fp[x.guard]++
    await t.test(`allow.txt:${e.line} ${show(e.raw)}`, e.todo ? { todo: e.todo } : {}, () => {
      const crash = rs.filter(x => crashed(x.r))
      assert.deepStrictEqual(crash.map(x => `${x.guard} exit ${x.r.status}: ${firstLine(x.r.stderr)}`), [], 'hook crashed')
      assert.deepStrictEqual(bad.map(x => `${x.guard}: ${firstLine(x.r.stderr)}`), [],
        `false positive at allow.txt:${e.line} (${e.section})\n  command: ${H.decode(e.raw)}`)
    })
    if (e.todo && !bad.length) t.diagnostic(`allow.txt:${e.line} is marked todo but now passes; remove the todo mark`)
  }
  t.diagnostic(`allow: ${byLine.size} commands x ${H.GUARDS.length} guards; blocked per guard: ${JSON.stringify(fp)}`)
})

function parseBlock(e) {
  const [tag, ...rest] = e.raw.split('\t')
  const [guard, ...opts] = tag.split(',')
  const o = Object.fromEntries(opts.map(x => x.split('=')))
  return { guard, command: H.decode(rest.join('\t')), timeout: Number(o.timeout) || 120000, platform: o.platform, state: o.state }
}

const platformMatches = p => !p || (p === 'win32' ? process.platform === 'win32' : process.platform !== 'win32')

test('block corpus: each guard blocks what it is for', { timeout: 900000 }, async t => {
  const entries = H.readCorpus(BLOCK).map(e => ({ e, ...parseBlock(e) }))
  const runnable = entries.filter(x => platformMatches(x.platform))
  const results = await H.pool(runnable.map(x => () =>
    run(x.guard, x.command, { state: x.state || BLOCK_STATE[x.guard], tool: x.e.tool, timeout: x.timeout, config: x.e.config }).then(r => ({ ...x, r }))))
  const summary = {}
  for (const x of results) {
    const s = (summary[x.guard] = summary[x.guard] || { blocked: 0, missed: 0, todo: 0 })
    if (x.r.status === 2) s.blocked++
    else if (x.e.todo) s.todo++
    else s.missed++
  }
  for (const x of entries) {
    const r = results.find(y => y.e === x.e)
    const opts = !r ? { skip: `${x.platform} only` } : x.e.todo ? { todo: x.e.todo } : {}
    await t.test(`block.txt:${x.e.line} [${x.guard}] ${show(x.command)}`, opts, () => {
      assert.ok(!crashed(r.r), `${x.guard} crashed: exit ${r.r.status} ${firstLine(r.r.stderr)}`)
      assert.strictEqual(r.r.status, 2, `missed block at block.txt:${x.e.line}: ${x.guard} let it through\n  command: ${x.command}`)
      assert.match(r.r.stderr, new RegExp(`\\[bulkhead\\] ${x.guard === 'basics' ? 'basics' : x.guard}`))
    })
    if (r && x.e.todo && r.r.status === 2) t.diagnostic(`block.txt:${x.e.line} is marked todo but now blocks; remove the todo mark`)
  }
  t.diagnostic(`block per guard: ${JSON.stringify(summary)}`)
  // every block went to the event log in the temporary state directory, none to the real home
  const events = path.join(stateDirFor(null), 'events.jsonl')
  const logged = fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').length : 0
  assert.ok(logged > 0, 'blocks were not written to the temporary event log')
})
