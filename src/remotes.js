'use strict'
const fs = require('fs')
const path = require('path')

// The "remotes" section of the global config file: machines bulkhead remote may run jobs on.
// It is read from the global file only. A project's .claude/bulkhead.json comes with whatever
// repository you clone, and a cloned repository must not be able to make you ssh somewhere
// or pass ssh options such as ProxyCommand.

const DEFAULTS = { shell: 'bash', dir: '~/bulkhead-remote', copies: 4, maxJobs: 4, minFreeGb: 0, sshOptions: [] }
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
const MAX_COPIES = 8

const FIELDS = {
  host: v => typeof v === 'string' && /^[^\s-][^\s]*$/.test(v) ? null : 'should be user@host or an ssh config host name (no spaces, not starting with -)',
  shell: v => typeof v === 'string' && v.trim() && !/[\r\n]/.test(v) ? null : 'should be the remote shell command, such as bash',
  dir: v => typeof v === 'string' && v.trim() && !/[\r\n\0]/.test(v) ? null : 'should be a folder path on the remote',
  copies: v => Number.isInteger(v) && v >= 1 && v <= MAX_COPIES ? null : `should be a whole number from 1 to ${MAX_COPIES}`,
  maxJobs: v => Number.isInteger(v) && v >= 1 && v <= 64 ? null : 'should be a whole number from 1 to 64',
  minFreeGb: v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? null : 'should be a number of GB, 0 or more',
  // -o options only, written Key=value. scp, sftp and ssh all take them the same way, while
  // flags differ (-p is the port for ssh but "preserve times" for scp).
  sshOptions: v => Array.isArray(v) && v.every(o => typeof o === 'string' && /^[A-Za-z][A-Za-z0-9]*[= ]\S/.test(o) && !/[\r\n]/.test(o))
    ? null : 'should be a list of ssh -o options such as "IdentityFile=~/.ssh/buildbox" or "Port=2222"',
}

// One entry with defaults filled in, or the problems that keep it out.
function normalize(name, entry) {
  const problems = []
  if (!NAME.test(name)) problems.push(`remotes: "${name}" is not a valid name (letters, digits, . _ -)`)
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { problems: [...problems, `remotes.${name} should be an object with at least "host"`] }
  if (entry.host === undefined) problems.push(`remotes.${name}.host is missing`)
  for (const [k, v] of Object.entries(entry)) {
    if (!FIELDS[k]) problems.push(`unknown key "remotes.${name}.${k}"`)
    else {
      const why = FIELDS[k](v)
      if (why) problems.push(`"remotes.${name}.${k}" ${why}`)
    }
  }
  if (problems.length) return { problems }
  return { remote: { name, ...DEFAULTS, ...entry, sshOptions: [...(entry.sshOptions || [])] }, problems }
}

// { remotes: { name: remote }, problems: [] }. A bad entry is dropped whole, so a typo in
// sshOptions never means connecting with the wrong key.
function normalizeAll(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { remotes: {}, problems: ['"remotes" should be an object of name: { host, ... }'] }
  const remotes = {}
  const problems = []
  for (const [name, entry] of Object.entries(body)) {
    const r = normalize(name, entry)
    if (r.remote) remotes[name] = r.remote
    problems.push(...r.problems)
  }
  return { remotes, problems }
}

function readJson(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return {}
    throw new Error(`cannot read ${file}: ${e.message}`)
  }
  if (!text.trim()) return {}
  let obj
  try {
    obj = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); fix it first, it was not changed`)
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${file} should hold a JSON object; it was not changed`)
  return obj
}

// Reads the global file, lets `change` edit the object, and writes it back through a temporary
// file and a rename, so a crash never leaves half a file. Other keys keep their order.
// `change` returns false to leave the file untouched.
function editFile(file, change) {
  const obj = readJson(file)
  if (change(obj) === false) return obj
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
  return obj
}

function addRemote(file, name, entry, { makeDefault = false } = {}) {
  const check = normalize(name, entry)
  if (!check.remote) throw new Error(check.problems.join('; '))
  let existed = false
  editFile(file, obj => {
    if (obj.remotes !== undefined && (!obj.remotes || typeof obj.remotes !== 'object' || Array.isArray(obj.remotes))) {
      throw new Error(`"remotes" in ${file} is not an object; fix it first, the file was not changed`)
    }
    obj.remotes = obj.remotes || {}
    existed = name in obj.remotes
    obj.remotes[name] = entry
    if (makeDefault) obj.remote = { ...(obj.remote || {}), default: name }
  })
  return { remote: check.remote, existed }
}

function removeRemote(file, name) {
  let found = false
  editFile(file, obj => {
    found = Boolean(obj.remotes && typeof obj.remotes === 'object' && name in obj.remotes)
    if (!found) return false
    delete obj.remotes[name]
    if (!Object.keys(obj.remotes).length) delete obj.remotes
    if (obj.remote && obj.remote.default === name) {
      delete obj.remote.default
      if (!Object.keys(obj.remote).length) delete obj.remote
    }
  })
  return found
}

module.exports = { normalize, normalizeAll, addRemote, removeRemote, readJson, DEFAULTS, MAX_COPIES, NAME }
