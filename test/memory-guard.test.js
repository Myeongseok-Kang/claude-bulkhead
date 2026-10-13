'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { check, isHeavy, touchesSlotFiles } = require('../src/memory-guard')
const { runScript } = require('./helpers')

const low = () => ({ freeGb: 1.4, totalGb: 32 })
const plenty = () => ({ freeGb: 12, totalGb: 32 })

test('recognizes heavy commands', () => {
  for (const cmd of [
    'npx vitest run --maxWorkers=4',
    'npm run build',
    'pnpm test',
    'cd web && npx next build',
    './gradlew assembleDebug',
    'emulator -avd Pixel_7 -no-window',
    'npx playwright test',
    'cargo test',
    'docker build -t app .',
    'node -e "require(\'playwright\').chromium.launch()"',
    'bash -c "npm test"',
    'mvn clean install',
    'gradle build',
    'pytest -n 8',
    'go test ./...',
  ]) assert.ok(isHeavy(cmd), cmd)
  for (const cmd of ['ls -la', 'git status', 'grep -rn "vitest" src', 'npm ci', 'bulkhead-slot run --gb=3 -- npm test', 'cat package.json',
    'grep -rn vitest package.json', 'rg tsc docs', 'git log --grep=playwright', 'cat jest.config.js | head', 'bulkhead slot run -- npx tsc',
    'pytest -x', 'npx vite preview', 'ls jest.config.js', 'ssh build-host npm test', 'git commit -m "speed up vitest"']) {
    assert.ok(!isHeavy(cmd), cmd)
  }
})

test('blocks heavy commands only when RAM is low', () => {
  assert.match(check('npm test', low), /1\.4 GB/)
  assert.strictEqual(check('npm test', plenty), null)
  assert.strictEqual(check('ls', low), null)
})

test('the default minimum scales down on small machines', () => {
  const laptop = () => ({ freeGb: 1.4, totalGb: 8 })
  assert.strictEqual(check('npm test', laptop), null)
  assert.match(check('npm test', () => ({ freeGb: 1.1, totalGb: 8 })), /minimum 1\.2 GB/)
  assert.match(check('npm test', laptop, 3), /minimum 3 GB/)
})

test('blocks hand edits to slot files', () => {
  assert.ok(touchesSlotFiles('rm ~/.claude/bulkhead/slots/slot-1.json'))
  assert.ok(touchesSlotFiles('while true; do sleep 240; echo x > ~/.claude/bulkhead/slots/slot-2.json; done &'))
  assert.ok(touchesSlotFiles('Remove-Item C:\\Users\\me\\.claude\\bulkhead\\slots\\slot-3.json'))
  assert.ok(!touchesSlotFiles('cat ~/.claude/bulkhead/slots/slot-1.json'))
  assert.ok(!touchesSlotFiles('bulkhead-slot status > status.txt'))
  assert.ok(!touchesSlotFiles('ls ~/.claude/bulkhead/slots 2>/dev/null'))
  assert.ok(!touchesSlotFiles('ls ~/.claude/bulkhead/slots 2>&1 | head'))
  assert.match(check('rm ~/.claude/bulkhead/slots/slot-1.json', plenty), /managed by bulkhead-slot/)
})

test('hook reads memory and honours the minimum', () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'npm run build' } }
  const lowMem = { BULKHEAD_TEST_MEMORY: JSON.stringify({ freeGb: 1, totalGb: 16 }) }
  assert.strictEqual(runScript('memory-guard', input, lowMem).status, 2)
  assert.strictEqual(runScript('memory-guard', input, { ...lowMem, BULKHEAD_MIN_FREE_GB: '0.5' }).status, 0)
  assert.strictEqual(runScript('memory-guard', input, { ...lowMem, BULKHEAD_DISABLE: 'memory-guard' }).status, 0)
})
