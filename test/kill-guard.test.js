'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { check, message } = require('../src/kill-guard')
const { runScript } = require('./helpers')

const blocked = [
  'taskkill /F /IM node.exe',
  'taskkill //F //IM node.exe',
  'taskkill /IM "python.exe" /F',
  'taskkill //F //IM python.exe',
  'cd app && taskkill /F /IM chrome.exe /T',
  'taskkill /F /FI "IMAGENAME eq node.exe"',
  'Stop-Process -Name node -Force',
  'Get-Process node | Stop-Process -Force',
  'gps chrome | kill',
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Invoke-CimMethod -MethodName Terminate",
  "Get-CimInstance Win32_Process | ? { $_.Name -eq 'node.exe' } | % { Stop-Process -Id $_.ProcessId }",
  'wmic process where name="node.exe" delete',
  'pkill node',
  'pkill -f next',
  'pkill -9 -f "next dev"',
  'killall -9 node',
  'kill $(pgrep node)',
  'kill -9 $(pgrep -f vite)',
  'pgrep -f python | xargs kill',
  "ps aux | grep node | awk '{print $2}' | xargs kill -9",
  'npm run build; pkill node',
  'bash -c "pkill node"',
]

const allowed = [
  'taskkill /PID 4312 /T /F',
  'taskkill //PID 4312 //T //F',
  'taskkill /F /FI "PID eq 4312"',
  'taskkill /IM qemu-system-x86_64.exe /F',
  'Stop-Process -Id 4312 -Force',
  "Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*C:\\work\\shop*' } | % { Stop-Process -Id $_.ProcessId }",
  'Get-Process node | Where-Object { $_.Id -eq 4312 } | Stop-Process',
  'lsof -ti :3000 | xargs kill',
  'kill $(lsof -ti :5173)',
  'kill -- -4312',
  "pkill -f '/home/dev/src/acme-web/server.js'",
  'pkill -f node_modules/.bin/vite',
  'pgrep -af node',
  'fuser -k 3000/tcp',
  'git commit -m "stop using pkill node in scripts"',
  'grep -rn "taskkill /IM node.exe" docs/',
  'echo "never run killall node"',
  'npm test',
  // commands people run every day that must not be blocked
  'pkill -f ./scripts/worker.py',
  'pkill -f "python scripts/worker.py"',
  'killall -0 node',
  'kill %1',
  'tail -f log & sleep 3; kill %1',
  'kill $(cat server.pid)',
  'kill -TERM $SERVER_PID',
  'docker stop web',
  'docker kill web',
  'npx kill-port 3000',
  'adb kill-server',
  'git log --grep=killall',
  'grep -r taskkill .',
  "printf 'killall node\\n'",
  "cat > notes.md <<'EOF'\nnever run pkill node here\nEOF",
  'Get-Process node | Select-Object Id, CPU',
  'ps aux | grep node',
]

test('blocks name and filter based kills', () => {
  for (const cmd of blocked) assert.ok(check(cmd), `should block: ${cmd}`)
})

test('allows PID, port and path scoped kills', () => {
  for (const cmd of allowed) assert.strictEqual(check(cmd), null, `should allow: ${cmd}`)
})

test('message explains how to find a PID on each platform', () => {
  assert.match(message('x', 'win32'), /netstat -ano/)
  assert.match(message('x', 'win32'), /taskkill \/PID/)
  assert.match(message('x', 'linux'), /lsof -ti/)
  assert.match(message('x', 'darwin'), /kill <pid>/)
})

test('hook exits 2 on a block and 0 otherwise', () => {
  const hit = runScript('kill-guard', { tool_name: 'Bash', tool_input: { command: 'taskkill /F /IM node.exe' } })
  assert.strictEqual(hit.status, 2)
  assert.match(hit.stderr, /kill-guard/)
  assert.strictEqual(runScript('kill-guard', { tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0)
  assert.strictEqual(runScript('kill-guard', 'not json').status, 0)
})

test('BULKHEAD_DISABLE turns it off', () => {
  const r = runScript('kill-guard', { tool_input: { command: 'pkill node' } }, { BULKHEAD_DISABLE: 'kill-guard' })
  assert.strictEqual(r.status, 0)
})
