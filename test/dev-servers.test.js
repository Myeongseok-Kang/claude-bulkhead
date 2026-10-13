'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { detect } = require('../src/dev-servers')

const packages = {
  [path.resolve('/w/app', 'package.json')]: {
    scripts: { dev: 'next dev --turbopack', web: 'vite', both: 'npm run web', api: 'node server.js', fixed: 'next dev -p 3000', preview: 'vite preview' },
  },
  [path.resolve('/w/app/site', 'package.json')]: { scripts: { dev: 'astro dev' } },
}
const readFile = p => {
  if (packages[p]) return JSON.stringify(packages[p])
  throw new Error('ENOENT')
}
const port = cmd => {
  const r = detect(cmd, { cwd: '/w/app', readFile })
  return r ? r.port : undefined
}

const cases = [
  ['next dev', 3000],
  ['npx next dev -p 3005', 3005],
  ['next dev --port=3006', 3006],
  ['PORT=4000 next dev', 4000],
  ['next start', 3000],
  ['vite', 5173],
  ['npx vite --port 5200', 5200],
  ['PORT=9999 vite', 5173],
  ['vite preview', 4173],
  ['astro dev', 4321],
  ['nuxi dev', 3000],
  ['remix dev', 3000],
  ['remix vite:dev', 5173],
  ['npx expo start', 8081],
  ['python -m http.server', 8000],
  ['python3 -m http.server 8080 --bind 127.0.0.1', 8080],
  ['uvicorn app.main:app --reload', 8000],
  ['python -m uvicorn app:app --port 8100', 8100],
  ['flask run', 5000],
  ['FLASK_RUN_PORT=5100 flask run', 5100],
  ['bundle exec rails s -p 3002', 3002],
  ['rails server', 3000],
  ['python manage.py runserver', 8000],
  ['python manage.py runserver 0.0.0.0:8001', 8001],
  ['php artisan serve --port=8100', 8100],
  ['ng serve', 4200],
  ['hugo server', 1313],
  ['npx wrangler dev', 8787],
  ['npx storybook dev -p 6007', 6007],
]

test('knows each tool default and explicit ports', () => {
  for (const [cmd, want] of cases) assert.strictEqual(port(cmd), want, cmd)
})

test('follows package scripts, extra args and env', () => {
  assert.strictEqual(port('npm run dev'), 3000)
  assert.strictEqual(port('npm run dev -- -p 3100'), 3100)
  assert.strictEqual(port('pnpm dev --port 3200'), 3200)
  assert.strictEqual(port('yarn web'), 5173)
  assert.strictEqual(port('bun run preview'), 4173)
  assert.strictEqual(port('pnpm both'), 5173)
  assert.strictEqual(port('PORT=4000 npm run dev'), 4000)
  assert.strictEqual(port('$env:PORT=4100; npm run dev'), 4100)
  assert.strictEqual(port('$env:PORT = "4101"; npm run dev'), 4101)
  assert.strictEqual(port('set PORT=4200 && npm run dev'), 4200)
  assert.strictEqual(port('cd site && npm run dev > dev.log 2>&1 &'), 4321)
  assert.strictEqual(port('npm --prefix site run dev'), 4321)
  // the last port flag wins, as it does in the tools
  assert.strictEqual(port('npm run fixed -- -p 3001'), 3001)
})

test('ports it cannot work out are null', () => {
  assert.strictEqual(port('next dev --port $PORT'), null)
  assert.strictEqual(port('PORT=$P npm run dev'), null)
})

test('ignores commands that do not start a dev server', () => {
  for (const cmd of ['npm test', 'npm install', 'npm run api', 'npm run missing', 'next build', 'vite build', 'npx astro build',
    'git commit -m "start next dev on 3000"', 'grep -r "vite" src', 'echo next dev', 'ls', 'cd /w && ls']) {
    assert.strictEqual(port(cmd), undefined, cmd)
  }
})

test('hints keep the command and swap the port', () => {
  const hint = cmd => detect(cmd, { cwd: '/w/app', readFile }).hint(3001)
  assert.strictEqual(hint('uvicorn app:main --reload --port 8000'), 'uvicorn app:main --reload --port 3001')
  assert.strictEqual(hint('npx next dev -p 3000 > dev.log'), 'npx next dev --port 3001')
  assert.strictEqual(hint('python manage.py runserver 0.0.0.0:8000'), 'python manage.py runserver 3001')
  assert.strictEqual(hint('npm run dev'), 'npm run dev -- --port 3001')
})
