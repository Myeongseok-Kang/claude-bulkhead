'use strict'
// Preloaded with `node --require` into a hook process by the corpus and fuzz tests.
// It replaces the parts of the machine a hook would otherwise read live, so results do not
// depend on which sessions, servers and ports happen to exist on the test machine.
//
// BULKHEAD_CORPUS_MOCK is a JSON object:
//   listening: true | false        every TCP connect succeeds or fails
//   snapshot:  { procs, ports }    what readProcesses() returns
//   sessionFiles: [[pid, file]]    what readSessionFiles() returns
//   self:      pid | null          what ownSession() returns
// Without the variable this file does nothing (node --test also loads it as a test file).

const raw = process.env.BULKHEAD_CORPUS_MOCK
if (raw) {
  const path = require('path')
  const net = require('net')
  const { EventEmitter } = require('events')
  const mock = JSON.parse(raw)
  const src = path.join(__dirname, '..', '..', 'src')

  net.connect = () => {
    const sock = new EventEmitter()
    sock.setTimeout = () => sock
    sock.destroy = () => sock
    process.nextTick(() => (mock.listening ? sock.emit('connect') : sock.emit('error', new Error('ECONNREFUSED'))))
    return sock
  }

  const processes = require(path.join(src, 'processes.js'))
  processes.readProcesses = () => mock.snapshot || { procs: [], listening: new Set(), ports: [] }

  const sessions = require(path.join(src, 'sessions.js'))
  sessions.readSessionFiles = () => new Map((mock.sessionFiles || []).map(([pid, f]) => [Number(pid), f]))
  sessions.ownSession = () => (mock.self === undefined ? null : mock.self)
}
