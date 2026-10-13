'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const path = require('path')
const { spawnSync } = require('child_process')
const { findFree, isFree } = require('../src/port-cli')

test('skips ports in use and ports browsers refuse', async () => {
  const taken = new Set([3000, 3001])
  const bind = async (host, port) => !taken.has(port)
  assert.strictEqual(await findFree(3000, { bind }), 3002)
  assert.strictEqual(await findFree(5060, { bind }), 5062)
  assert.strictEqual(await findFree(6665, { bind }), 6670)
  assert.strictEqual(await findFree(80, { bind }), 1024)
  assert.strictEqual(await findFree(3000, { bind: async () => false, span: 5 }), null)
})

test('a port taken on any one address is not free', async () => {
  const server = net.createServer().listen({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const { port } = server.address()
  try {
    assert.strictEqual(await isFree(port), false)
    const next = await findFree(port)
    assert.ok(next > port)
    assert.strictEqual(await isFree(next), true)
  } finally {
    server.close()
  }
})

test('bulkhead port prints just the number', () => {
  const bin = path.join(__dirname, '..', 'bin', 'bulkhead')
  const r = spawnSync(process.execPath, [bin, 'port', '--near', '41000'], { encoding: 'utf8' })
  assert.strictEqual(r.status, 0, r.stderr)
  assert.match(r.stdout, /^\d+\n$/)
  assert.ok(Number(r.stdout) >= 41000)
  const j = spawnSync(process.execPath, [bin, 'port', '--near=41000', '--json'], { encoding: 'utf8' })
  assert.ok(JSON.parse(j.stdout).port >= 41000)
  const bad = spawnSync(process.execPath, [bin, 'port', '--near', 'abc'], { encoding: 'utf8' })
  assert.strictEqual(bad.status, 1)
})
