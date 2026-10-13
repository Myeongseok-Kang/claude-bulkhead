'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { check, changesTree } = require('../src/checkout-guard')
const { runScript, tempDir } = require('./helpers')

const repo = path.resolve('/work/shop')
const nested = path.join(repo, 'vendor', 'lib')

// git answers from a table: toplevel per directory, porcelain status per repo.
function fakeGit({ status = '' } = {}) {
  return (args, cwd) => {
    if (args[0] === 'rev-parse') {
      if (cwd.startsWith(nested)) return nested
      if (cwd.startsWith(repo)) return repo
      throw new Error('not a git repository')
    }
    if (args[0] === 'status') return status
    throw new Error('unexpected git ' + args.join(' '))
  }
}

const sessions = new Map([
  [100, { cwd: repo, startedAt: new Date(2026, 9, 13, 9, 5).getTime(), sessionId: 'me' }],
  [200, { cwd: path.join(repo, 'web'), startedAt: new Date(2026, 9, 13, 10, 40).getTime(), sessionId: 'other' }],
  [300, { cwd: path.resolve('/work/blog'), startedAt: 0, sessionId: 'third' }],
  [400, { cwd: nested, startedAt: 0, sessionId: 'fourth' }],
  [500, { cwd: repo, startedAt: 0, sessionId: 'dead' }],
])
const ctx = (over = {}) => ({
  cwd: repo, sessionId: 'me', files: () => sessions, isAlive: pid => pid !== 500, run: fakeGit(), ...over,
})

test('blocks commands that move a tree another session is in', () => {
  for (const cmd of ['git checkout main', 'git checkout -b fix/login', 'git checkout -', 'git switch -c feature', 'git stash',
    'git stash pop', 'git stash push -u', 'git reset --hard HEAD~1', 'git clean -fd', 'git rebase main', 'git merge feature',
    'git restore .', 'git checkout -- .', 'cd web && git checkout main', 'git -C web switch main']) {
    const msg = check(cmd, ctx())
    assert.ok(msg, cmd)
    assert.match(msg, /pid 200, started 2026-10-13 10:40/, cmd)
  }
  assert.match(check('git checkout main', ctx()), /git worktree add \.\.\/shop-<task> -b <branch>/)
})

test('pull is blocked only with uncommitted changes', () => {
  assert.strictEqual(check('git pull', ctx()), null)
  assert.match(check('git pull --rebase', ctx({ run: fakeGit({ status: ' M src/app.js' }) })), /uncommitted changes/)
})

test('passes when nobody else is in the tree', () => {
  const alone = ctx({ files: () => new Map([[100, sessions.get(100)], [300, sessions.get(300)]]) })
  for (const cmd of ['git checkout main', 'git stash', 'git reset --hard']) assert.strictEqual(check(cmd, alone), null, cmd)
  // a session inside a nested repository does not share this tree
  assert.strictEqual(check('git checkout main', ctx({ files: () => new Map([[400, sessions.get(400)]]) })), null)
  // dead sessions do not count
  assert.strictEqual(check('git checkout main', ctx({ files: () => new Map([[500, sessions.get(500)]]) })), null)
})

test('commands that leave the tree alone pass', () => {
  for (const cmd of ['git status', 'git log --oneline', 'git diff', 'git commit -m "checkout main later"', 'git stash list',
    'git stash show -p', 'git checkout -- src/app.js', 'git restore src/app.js', 'git rebase --continue', 'git merge --abort',
    'git fetch', 'git branch -d old', 'git restore --staged .', 'git restore -S -- .', 'git clean -fdn', 'git worktree add ../shop-fix -b fix', 'echo git checkout main']) {
    assert.strictEqual(check(cmd, ctx()), null, cmd)
  }
  assert.strictEqual(changesTree({ sub: 'checkout', args: ['src/app.js'], dir: repo }, () => true), null)
  assert.strictEqual(changesTree({ sub: 'checkout', args: ['main'], dir: repo }, () => false), 'switches the branch')
})

test('fails open without a session id or outside git', () => {
  assert.strictEqual(check('git checkout main', ctx({ sessionId: null })), null)
  assert.strictEqual(check('git checkout main', ctx({ cwd: path.resolve('/tmp') })), null)
})

test('does not run git when no other session is alive', () => {
  const run = () => assert.fail('git should not run')
  assert.strictEqual(check('git checkout main', ctx({ run, isAlive: () => false })), null)
})

test('a session that entered the tree through a link still shares it', () => {
  // git reports the real path; the other session's directory is a symlink (a junction on
  // Windows, which needs no admin rights) to the same tree.
  const real = tempDir()
  execFileSync('git', ['init', '-q'], { cwd: real, stdio: 'ignore' })
  const link = path.join(tempDir(), 'shop')
  fs.symlinkSync(real, link, 'junction')
  const files = () => new Map([[200, { cwd: link, startedAt: 0, sessionId: 'other' }]])
  assert.match(check('git checkout main', { cwd: real, sessionId: 'me', files, isAlive: () => true }), /pid 200/)
})

test('hook fails open', () => {
  const env = { CLAUDE_CONFIG_DIR: tempDir() }
  assert.strictEqual(runScript('checkout-guard', { session_id: 'x', cwd: process.cwd(), tool_input: { command: 'git checkout main' } }, env).status, 0)
  assert.strictEqual(runScript('checkout-guard', 'not json').status, 0)
})
