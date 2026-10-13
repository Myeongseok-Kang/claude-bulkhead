'use strict'
const fs = require('fs')
const path = require('path')

// The spelling git and the file system agree on. git prints a repository's real path, while a
// session's cwd or the home directory may come through a symlink, a junction, macOS /tmp
// (/private/tmp) or a Windows short name (C:\Users\RUNNER~1). Two spellings of one folder
// compare equal only after both go through this. The part of the path that exists is resolved;
// the rest, such as a folder a command is about to create, is kept as written on top of it.
function realPath(p) {
  const abs = path.resolve(p)
  const rest = []
  let head = abs
  for (;;) {
    try {
      return rest.length ? path.join(fs.realpathSync.native(head), ...rest) : fs.realpathSync.native(head)
    } catch {}
    const up = path.dirname(head)
    if (up === head) return abs
    rest.unshift(path.basename(head))
    head = up
  }
}

// A form of a path for comparing: real, forward slashes, no trailing slash, and on Windows one case.
function pathKey(p, platform = process.platform) {
  const n = realPath(p).replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return platform === 'win32' ? n.toLowerCase() : n
}

module.exports = { realPath, pathKey }
