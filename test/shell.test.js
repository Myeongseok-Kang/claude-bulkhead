'use strict'
// The command reader every guard shares: words, wrappers, heredocs and message text.
const test = require('node:test')
const assert = require('node:assert')
const shell = require('../src/shell')

const argvs = (src, mode) => shell.commands(src, mode).map(c => c.argv.join(' '))

test('lex splits commands and keeps quoting out of the words', () => {
  const { cmds } = shell.lex(`echo "a b" 'c'; ls -la | grep x && npm test`)
  assert.deepStrictEqual(cmds.map(c => c.words.map(w => w.v)), [['echo', 'a b', 'c'], ['ls', '-la'], ['grep', 'x'], ['npm', 'test']])
  assert.deepStrictEqual(cmds.map(c => c.seg), [0, 1, 1, 2])
})

test('lex marks $( ), backticks and <( ) as sub commands', () => {
  const { cmds } = shell.lex('kill $(pgrep node) `cat pid` <(ls)')
  const subs = cmds.filter(c => c.sub).map(c => c.words.map(w => w.v).join(' '))
  assert.deepStrictEqual(subs.sort(), ['cat pid', 'ls', 'pgrep node'])
})

test('lex keeps redirections such as 2>&1 and &> inside the statement', () => {
  const { cmds } = shell.lex('npm test > out.log 2>&1 && echo ok')
  assert.deepStrictEqual(cmds.map(c => c.seg), [0, 1])
  assert.ok(cmds[0].words.some(w => w.v === '2>&1'))
})

test('lex reads PowerShell and cmd quoting', () => {
  assert.deepStrictEqual(shell.lex("Write-Host 'it''s' \"a`\"b\"", 'ps').cmds[0].words.map(w => w.v), ['Write-Host', "it's", 'a"b'])
  assert.deepStrictEqual(shell.lex('echo a^&b', 'cmd').cmds[0].words.map(w => w.v), ['echo', 'a&b'])
})

test('lex reports an unterminated quote', () => {
  assert.strictEqual(shell.lex('echo "open').unterminated, true)
  assert.strictEqual(shell.lex('echo "closed"').unterminated, false)
})

test('strip drops prefixes and assignments before the real command', () => {
  for (const [src, want] of [
    ['sudo -u dev pkill node', 'pkill node'],
    ['env FOO=1 BAR=2 npm test', 'npm test'],
    ['NODE_ENV=test nice -n 5 nohup time npm test', 'npm test'],
    ['timeout 60 npm test', 'npm test'],
    ['xargs -I{} rm {}', 'rm {}'],
  ]) assert.deepStrictEqual(argvs(src), [want], src)
})

test('commands opens shell wrappers up to three levels deep', () => {
  assert.deepStrictEqual(argvs('bash -c "pkill node"'), ['pkill node'])
  assert.deepStrictEqual(argvs(`sh -c "bash -c 'zsh -c \\"ls\\"'"`), ['ls'])
  assert.deepStrictEqual(argvs('cmd /c "taskkill /F /IM node.exe"'), ['taskkill /F /IM node.exe'])
  assert.deepStrictEqual(argvs('pwsh -NoProfile -Command "Get-Process node"'), ['Get-Process node'])
  assert.deepStrictEqual(argvs("eval 'npm test'"), ['npm test'])
  const deep = 'bash -c "bash -c \\"bash -c \\\\\\"bash -c ls\\\\\\"\\""'
  assert.ok(argvs(deep).every(a => a.startsWith('bash')), 'the fourth level stays closed')
})

test('commands decodes powershell -EncodedCommand', () => {
  const enc = Buffer.from('Get-Process node', 'utf16le').toString('base64')
  assert.deepStrictEqual(argvs(`powershell -EncodedCommand ${enc}`), ['Get-Process node'])
})

test('commands marks ssh and container exec as remote', () => {
  for (const src of ['ssh build-host pkill node', 'docker exec web pkill node', 'kubectl exec api-0 -- pkill node']) {
    assert.strictEqual(shell.commands(src)[0].remote, true, src)
  }
  assert.strictEqual(shell.commands('docker ps')[0].remote, false)
})

test('unwrap with remote opens the command that runs on the other side', () => {
  assert.match(shell.unwrap('ssh build-host "sleep 300"', 'sh', 0, { remote: true }), /\(\s*sleep 300\s*\)/)
  assert.strictEqual(shell.unwrap('docker exec -d web sleep 600', 'sh', 0, { remote: true }), 'docker exec -d web sleep 600')
  assert.strictEqual(shell.unwrap('ls -la'), 'ls -la')
})

test('prepare removes commit and pull request text', () => {
  for (const src of [
    'git commit -m "pkill node"',
    'git commit --message="sleep 600"',
    'gh pr create --title "rm -rf /" --body "taskkill /IM node.exe"',
    "gh release create v1 --notes 'killall node'",
    "git commit -F - <<'EOF'\npkill node\nEOF",
  ]) {
    const out = shell.prepare(src)
    assert.doesNotMatch(out, /pkill|sleep 600|rm -rf|taskkill|killall/, src)
  }
})

test('prepare keeps heredocs that a shell or interpreter runs', () => {
  assert.match(shell.prepare("bash <<'EOF'\npkill node\nEOF"), /pkill node/)
  assert.match(shell.prepare("python3 - <<'EOF'\nimport time\nEOF"), /import time/)
  assert.doesNotMatch(shell.prepare("cat > run.sh <<'EOF'\npkill node\nEOF"), /pkill node/)
})

test('modeFor picks PowerShell from the tool name', () => {
  assert.strictEqual(shell.modeFor({ tool_name: 'PowerShell' }), 'ps')
  assert.strictEqual(shell.modeFor({ tool_name: 'Bash' }), 'sh')
  assert.strictEqual(shell.modeFor(null), 'sh')
})

test('nested openers stay linear', () => {
  for (const unit of ['$(', '<(', '`', '((']) {
    const src = unit.repeat(100000)
    const t = Date.now()
    shell.commands(src)
    shell.commands(src, 'ps')
    assert.ok(Date.now() - t < 2000, `${unit} x 100000 took ${Date.now() - t} ms`)
  }
})
