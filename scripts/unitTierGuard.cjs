// Loaded into every unit-test process (`-r`). A unit test opens no database,
// no store, no socket to another machine and no child process; this makes each
// of those throw at once, saying so, instead of waiting on a server that the
// per-commit run does not have. Loopback sockets stay open: an in-process
// server on port 0 is a unit test's own.
const childProcess = require('node:child_process')
const net = require('node:net')

const RULE =
  'name the file *.integration.test.ts(x) and run it with npm run test.integration'

class UnitTierError extends Error {}

function refuse(what) {
  return new UnitTierError(`A unit test ${what}; ${RULE}`)
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'])

/** Where a `Socket#connect` call is going, from its arguments. */
function destination(args) {
  const [first, second] = args
  if (Array.isArray(first)) return destination(first)
  if (first != null && typeof first === 'object') {
    if (first.path != null) return { local: true }
    return { host: first.host ?? 'localhost', port: first.port }
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { local: true }
  return {
    host: typeof second === 'string' ? second : 'localhost',
    port: first
  }
}

/** Whether a connection to these arguments stays on this machine. */
function isLocal(args) {
  const where = destination(args)
  return where.local === true || LOOPBACK.has(String(where.host))
}

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  if (!isLocal(args)) {
    const { host, port } = destination(args)
    throw refuse(`opened a connection to ${String(host)}:${String(port)}`)
  }
  return connect.apply(this, args)
}

for (const name of [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork'
]) {
  childProcess[name] = function () {
    throw refuse(`started a child process (child_process.${name})`)
  }
}

// ES modules that imported these by name see the guarded ones too.
require('node:module').syncBuiltinESMExports()

module.exports = { UnitTierError, destination, isLocal, refuse, RULE }
