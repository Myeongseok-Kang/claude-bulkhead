'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { load, isEnabled, projectFile, KEYS } = require('../src/config')
const { notice } = require('../src/config-check')
const { runScript, tempDir } = require('./helpers')

const BIN = path.join(__dirname, '..', 'bin', 'bulkhead')

// A state dir with a global config and a repo with a project config.
function setup(globalCfg, projectCfg) {
  const state = tempDir()
  const repo = tempDir()
  fs.mkdirSync(path.join(repo, '.git'))
  fs.mkdirSync(path.join(repo, 'src'))
  if (globalCfg !== undefined) fs.writeFileSync(path.join(state, 'config.json'), typeof globalCfg === 'string' ? globalCfg : JSON.stringify(globalCfg))
  if (projectCfg !== undefined) {
    fs.mkdirSync(path.join(repo, '.claude'))
    fs.writeFileSync(path.join(repo, '.claude', 'bulkhead.json'), typeof projectCfg === 'string' ? projectCfg : JSON.stringify(projectCfg))
  }
  return { state, repo }
}

test('defaults when there are no files', () => {
  const { state, repo } = setup()
  const cfg = load({ env: { BULKHEAD_STATE_DIR: state }, cwd: repo })
  assert.strictEqual(cfg.values['waitGuard.limitSeconds'], 180)
  assert.deepStrictEqual(cfg.values['basics.protectedBranches'], ['main', 'master'])
  assert.strictEqual(cfg.sources['waitGuard.limitSeconds'], 'default')
  assert.deepStrictEqual(cfg.warnings, [])
  assert.ok(isEnabled('kill-guard', cfg))
})

test('project merges over global, environment wins over both', () => {
  const { state, repo } = setup(
    { waitGuard: { limitSeconds: 300 }, killGuard: { allowNames: ['ffmpeg'] }, portGuard: { enabled: false } },
    { waitGuard: { limitSeconds: 240 }, basics: { protectedBranches: ['main', 'release'] } },
  )
  const cfg = load({ env: { BULKHEAD_STATE_DIR: state }, cwd: path.join(repo, 'src') })
  assert.strictEqual(cfg.values['waitGuard.limitSeconds'], 240)
  assert.strictEqual(cfg.sources['waitGuard.limitSeconds'], path.join(repo, '.claude', 'bulkhead.json'))
  assert.deepStrictEqual(cfg.values['killGuard.allowNames'], ['ffmpeg'])
  assert.deepStrictEqual(cfg.values['basics.protectedBranches'], ['main', 'release'])
  assert.ok(!isEnabled('port-guard', cfg))
  const env = load({ env: { BULKHEAD_STATE_DIR: state, BULKHEAD_WAIT_MAX_SEC: '90', BULKHEAD_DISABLE: 'rm-root', BULKHEAD_NO_LOG: '1' }, cwd: repo })
  assert.strictEqual(env.values['waitGuard.limitSeconds'], 90)
  assert.strictEqual(env.sources['waitGuard.limitSeconds'], 'env BULKHEAD_WAIT_MAX_SEC')
  assert.ok(!isEnabled('rm-root', env))
  assert.ok(isEnabled('force-push-main', env))
  assert.strictEqual(env.values['log.enabled'], false)
  assert.ok(!isEnabled('kill-guard', load({ env: { BULKHEAD_STATE_DIR: state, BULKHEAD_DISABLE: 'all' }, cwd: repo })))
})

test('invalid JSON is ignored with one warning; bad keys and types are dropped', () => {
  const { state, repo } = setup('{ "waitGuard": { "limitSeconds": 30, } }', { waitGuard: { limitSecs: 1, limitSeconds: 'x' }, portGuard: { ignorePorts: [3000, 70000] }, killGuard: { enabled: false } })
  const cfg = load({ env: { BULKHEAD_STATE_DIR: state }, cwd: repo })
  assert.strictEqual(cfg.values['waitGuard.limitSeconds'], 180)
  assert.strictEqual(cfg.values['killGuard.enabled'], false)
  assert.deepStrictEqual(cfg.values['portGuard.ignorePorts'], [])
  assert.strictEqual(cfg.warnings.length, 4)
  assert.match(cfg.warnings[0], /config\.json is not valid JSON .*ignored until fixed/)
  assert.ok(cfg.warnings.some(w => /unknown key "waitGuard.limitSecs"/.test(w)))
  assert.ok(cfg.warnings.some(w => /"waitGuard.limitSeconds" should be number/.test(w)))
  assert.match(notice(cfg), /^\[bulkhead\] config problem/)
  assert.strictEqual(notice(load({ env: { BULKHEAD_STATE_DIR: tempDir() }, cwd: tempDir() })), null)
})

test('the project file is looked up to the repository root, not past it', () => {
  const { repo } = setup(undefined, {})
  assert.strictEqual(projectFile(path.join(repo, 'src')), path.join(repo, '.claude', 'bulkhead.json'))
  const inner = path.join(repo, 'pkg')
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true })
  assert.strictEqual(projectFile(inner), null)
})

test('the project file lookup stops at the home directory however it is spelled', () => {
  // home reached through a link (a junction on Windows), as C:\Users\RUNNER~1 is a second spelling on CI
  const base = tempDir()
  const proj = path.join(base, 'real', 'home', 'proj')
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(path.join(base, 'real', '.claude'))
  fs.writeFileSync(path.join(base, 'real', '.claude', 'bulkhead.json'), '{}')
  fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'), 'junction')
  assert.strictEqual(projectFile(proj, { home: path.join(base, 'link', 'home') }), null)
})

test('config.example.json is valid and uses only known keys', () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'))
  const state = tempDir()
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(example))
  const cfg = load({ env: { BULKHEAD_STATE_DIR: state }, cwd: tempDir() })
  assert.deepStrictEqual(cfg.warnings, [])
  // every key is in the example, so the example documents all of them
  for (const key of Object.keys(KEYS)) assert.notStrictEqual(cfg.sources[key], 'default', `missing from example: ${key}`)
})

test('hooks follow the config files', () => {
  const { state, repo } = setup({ killGuard: { allowNames: ['node'] }, waitGuard: { limitSeconds: 600 } }, { basics: { protectedBranches: ['release'] } })
  const env = { BULKHEAD_STATE_DIR: state, CLAUDE_PROJECT_DIR: repo }
  assert.strictEqual(runScript('kill-guard', { tool_input: { command: 'taskkill /F /IM node.exe' } }, env).status, 0)
  assert.strictEqual(runScript('kill-guard', { tool_input: { command: 'taskkill /F /IM python.exe' } }, env).status, 2)
  assert.strictEqual(runScript('wait-guard', { tool_input: { command: 'sleep 500', timeout: 600000 } }, env).status, 0)
  const push = runScript('basics', { cwd: repo, tool_input: { command: 'git push --force origin release' } }, env)
  assert.strictEqual(push.status, 2)
  assert.match(push.stderr, /force-pushing to release/)
  assert.strictEqual(runScript('basics', { cwd: repo, tool_input: { command: 'git push --force origin main' } }, env).status, 0)
  // a guard turned off in the project file
  const off = setup(undefined, { killGuard: { enabled: false } })
  assert.strictEqual(runScript('kill-guard', { tool_input: { command: 'pkill node' } }, { BULKHEAD_STATE_DIR: off.state, CLAUDE_PROJECT_DIR: off.repo }).status, 0)
  // a broken file leaves the defaults in place
  const broken = setup('{nope', undefined)
  assert.strictEqual(runScript('kill-guard', { tool_input: { command: 'pkill node' } }, { BULKHEAD_STATE_DIR: broken.state }).status, 2)
})

test('extra shared names are protected', () => {
  const { check } = require('../src/kill-guard')
  assert.strictEqual(check('pkill postgres'), null)
  assert.ok(check('pkill postgres', { extraSharedNames: ['postgres'] }))
  assert.strictEqual(check('pkill node', { allowNames: ['node.exe'] }), null)
  assert.ok(check('pkill node'))
})

test('the SessionStart check prints a notice for a broken file only', () => {
  const run = env => spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'config-check.js')], { input: '{}', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: tempDir(), ...env } })
  const bad = setup('{nope')
  const r = run({ BULKHEAD_STATE_DIR: bad.state })
  assert.strictEqual(r.status, 0)
  assert.match(JSON.parse(r.stdout).systemMessage, /not valid JSON/)
  assert.strictEqual(run({ BULKHEAD_STATE_DIR: tempDir() }).stdout, '')
})

test('bulkhead config shows each value and where it came from', () => {
  const { state, repo } = setup({ waitGuard: { limitSeconds: 300 } })
  const r = spawnSync(process.execPath, [BIN, 'config'], { encoding: 'utf8', cwd: repo, env: { ...process.env, BULKHEAD_STATE_DIR: state, CLAUDE_PROJECT_DIR: repo, BULKHEAD_MIN_FREE_GB: '2', NO_COLOR: '1' } })
  assert.strictEqual(r.status, 0, r.stderr)
  assert.match(r.stdout, /waitGuard\.limitSeconds\s+300\s+\S*config\.json/)
  assert.match(r.stdout, /memory\.minFreeGb\s+2\s+env BULKHEAD_MIN_FREE_GB/)
  assert.match(r.stdout, /killGuard\.enabled\s+true\s+default/)
  const j = spawnSync(process.execPath, [BIN, 'config', '--json'], { encoding: 'utf8', env: { ...process.env, BULKHEAD_STATE_DIR: state, CLAUDE_PROJECT_DIR: repo } })
  assert.strictEqual(JSON.parse(j.stdout).settings['waitGuard.limitSeconds'].value, 300)
})
