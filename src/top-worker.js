'use strict'
// Runs the process scan for `bulkhead top` off the main thread. On Windows the scan is a
// PowerShell call of a second or more, and the screen and keys must stay responsive meanwhile.
const { parentPort } = require('worker_threads')
const { collect } = require('./status')

parentPort.on('message', () => {
  const started = Date.now()
  try {
    parentPort.postMessage({ ok: true, st: collect(), ms: Date.now() - started })
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message, ms: Date.now() - started })
  }
})
