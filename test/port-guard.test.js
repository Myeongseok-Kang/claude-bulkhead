'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const { check, checkKill, killPorts, freePort, listening } = require('../src/port-guard')
const { ownSession } = require('../src/sessions')
const { runScript } = require('./helpers')

const t0 = Date.UTC(2026, 9, 13, 8)
const proc = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd, start, rss: 0, claudePid: null })

// Session 100 runs `next dev` on 3000. Session 200 is the one asking. 5432 belongs to nobody.
const snap = {
  procs: [
    proc(100, 1, 'claude', 'claude', t0),
    proc(110, 100, 'bash', 'bash -c "npm run dev"', t0 + 10e3),
    proc(111, 110, 'node', 'node next dev', t0 + 11e3),
    proc(200, 1, 'claude', 'claude', t0 + 60e3),
    proc(210, 200, 'node', 'node vite', t0 + 70e3),
    proc(300, 1, 'postgres', 'postgres', t0 - 1e6),
  ],
  ports: [{ port: 3000, pid: 111 }, { port: 3001, pid: 111 }, { port: 5173, pid: 210 }, { port: 5432, pid: 300 }],
}
const files = () => new Map([[100, { cwd: '/home/dev/src/acme-web', startedAt: 0 }]])
const as = me => ({ cwd: '/w', probe: async () => true, snapshot: () => snap, files, self: () => me })

test('blocks a port held by another session and names it', async () => {
  const msg = await check('npx next dev', as(200))
  assert.match(msg, /port 3000 is already used by another Claude session \(session pid 100, \/home\/dev\/src\/acme-web\): node pid 111/)
  assert.match(msg, /Port 3002 is free:\n {2}npx next dev --port 3002/)
  assert.match(await check('python -m http.server 3000', as(200)), /http\.server 3002/)
})

test('allows the same session, free ports, non-Claude owners and unknowns', async () => {
  assert.strictEqual(await check('npx next dev', as(100)), null)
  assert.strictEqual(await check('npx vite', as(200)), null)
  assert.strictEqual(await check('next dev -p 4000', as(200)), null)
  assert.strictEqual(await check('PORT=5432 next dev', as(200)), null)
  assert.strictEqual(await check('next dev --port $PORT', as(200)), null)
  assert.strictEqual(await check('npx next dev', as(null)), null)
  assert.strictEqual(await check('npm test', { ...as(200), snapshot: () => assert.fail('no scan for other commands') }), null)
  assert.strictEqual(await check('npx next dev', { ...as(200), snapshot: () => null }), null)
})

test('finds its own session through the parent chain', () => {
  const procs = [...snap.procs, proc(220, 200, 'bash', 'bash', t0 + 80e3), proc(221, 220, 'node', 'node port-guard.js', t0 + 81e3)]
  assert.strictEqual(ownSession(procs, 221, {}), 200)
  assert.strictEqual(ownSession(procs, 999, { CLAUDE_PID: '100' }), 100)
  assert.strictEqual(ownSession(procs, 999, {}), null)
})

test('nothing answering on the port means no process scan', async () => {
  const quiet = { ...as(200), probe: async () => false, snapshot: () => assert.fail('no scan when the port is free') }
  assert.strictEqual(await check('npx next dev', quiet), null)
})

test('listening() sees a real socket', async () => {
  const server = net.createServer().listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const { port } = server.address()
  try {
    assert.strictEqual(await listening(port), true)
  } finally {
    server.close()
  }
  await new Promise(resolve => server.once('close', resolve))
  assert.strictEqual(await listening(port), false)
})

test('free port skips taken ones', () => {
  assert.strictEqual(freePort(3000, new Set([3000, 3001, 3002])), 3003)
})

test('finds the ports a kill-by-port command aims at', () => {
  const cases = [
    ['npx kill-port 3000', [3000]],
    ['npx -y kill-port 3000 3001', [3000, 3001]],
    ['npx kill-port --port 3000,3001', [3000, 3001]],
    ['fuser -k 3000/tcp', [3000]],
    ['fuser -k -n tcp 3000', [3000]],
    ['fuser -k 3000/tcp 8080/tcp', [3000, 8080]],
    ['lsof -ti :3000 | xargs kill -9', [3000]],
    ['lsof -t -i:3000 | xargs kill', [3000]],
    ['lsof -ti tcp:5173 | xargs -r kill', [5173]],
    ['kill $(lsof -t -i:3000)', [3000]],
    ['kill -9 `lsof -ti :3000`', [3000]],
    ['Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess -Force', [3000]],
    ['Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess | Stop-Process', [3000]],
    ["for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :3000') do taskkill /F /PID %a", [3000]],
    ["netstat -ano | findstr :8080 | awk '{print $5}' | xargs taskkill //F //PID", [8080]],
    ['cd app && npx kill-port 4000 && npm run dev', [4000]],
  ]
  for (const [cmd, want] of cases) assert.deepStrictEqual(killPorts(cmd), want, cmd)
  // looking is not killing
  for (const cmd of ['lsof -ti :3000', 'netstat -ano | findstr :3000', 'Get-NetTCPConnection -LocalPort 3000', 'fuser 3000/tcp',
    'kill 4242', 'taskkill /PID 4242 /F', 'npm i -D kill-port', 'grep -rn "kill-port" .']) {
    assert.deepStrictEqual(killPorts(cmd), [], cmd)
  }
})

test('blocks a kill by port only when another session owns the port', async () => {
  const msg = (await checkKill('npx kill-port 3000', as(200))).message
  assert.match(msg, /`npx kill-port 3000` would stop node pid 111, the server another Claude session runs on port 3000 \(session pid 100, \/home\/dev\/src\/acme-web\)/)
  assert.match(msg, /3002 is free/)
  assert.match(msg, /bulkhead port/)
  assert.ok(await checkKill('lsof -ti :3000 | xargs kill -9', as(200)))
  assert.ok(await checkKill('npx kill-port 5173 3000', as(200)))
  // own session, nobody's port, unknown self, nothing listening, no snapshot
  assert.strictEqual(await checkKill('npx kill-port 3000', as(100)), null)
  assert.strictEqual(await checkKill('npx kill-port 5173', as(200)), null)
  assert.strictEqual(await checkKill('fuser -k 5432/tcp', as(200)), null)
  assert.strictEqual(await checkKill('npx kill-port 3000', as(null)), null)
  assert.strictEqual(await checkKill('npx kill-port 3000', { ...as(200), probe: async () => false, snapshot: () => assert.fail('no scan') }), null)
  assert.strictEqual(await checkKill('npx kill-port 3000', { ...as(200), snapshot: () => null }), null)
  assert.strictEqual(await checkKill('ls', { ...as(200), probe: () => assert.fail('no probe') }), null)
})

test('hook fails open', () => {
  assert.strictEqual(runScript('port-guard', { tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0)
  assert.strictEqual(runScript('port-guard', 'not json').status, 0)
  assert.strictEqual(runScript('port-guard', { tool_input: { command: 'npx next dev' } }, { BULKHEAD_DISABLE: 'port-guard' }).status, 0)
})
