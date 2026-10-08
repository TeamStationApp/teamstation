const { createHash } = require('node:crypto')
const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join, relative } = require('node:path')

// The device event-control contract fixtures exist once, in the Swift
// package, and every copy elsewhere in this repository must be byte-for-byte
// the same file:
//
//   node scripts/checkEventControlContract.cjs
//
// Prints one line per fixture with its SHA-256, and one per copy compared.
// Fails when a fixture is missing, when a copy differs, or when the Node
// reference in tools/eventControl reads its fixtures from anywhere else.

const ROOT = join(__dirname, '..')
const CANONICAL = 'mobile/apps/common/EventControl/Tests/Fixtures'
const FILES = [
  'assignments.json',
  'frames.json',
  'keys.json',
  'rejections.json',
  'scenarios.json'
]

// Directories holding copies of the fixtures. Each must hold every file, each
// identical to the canonical one. The Android test resources join this list
// when the Android implementation lands.
const COPIES = []

// The Node reference names the canonical directory itself, in this file.
const NODE_READER = 'tools/eventControl/fixtures.ts'

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function main({ root = ROOT, copies = COPIES, log = console.log } = {}) {
  let failed = false
  const fail = message => {
    failed = true
    log(`FAIL ${message}`)
  }
  const canonical = join(root, CANONICAL)
  const sums = new Map()
  for (const file of FILES) {
    const path = join(canonical, file)
    if (!existsSync(path)) {
      fail(`${CANONICAL}/${file} is missing`)
      continue
    }
    const sum = sha256(path)
    sums.set(file, sum)
    log(`${sum}  ${CANONICAL}/${file}`)
  }
  const extra = existsSync(canonical)
    ? readdirSync(canonical).filter(file => !FILES.includes(file))
    : []
  for (const file of extra) fail(`${CANONICAL}/${file} is not a known fixture`)

  for (const copy of copies) {
    for (const file of FILES) {
      const path = join(root, copy, file)
      if (!existsSync(path)) {
        fail(`${copy}/${file} is missing`)
        continue
      }
      const sum = sha256(path)
      if (sum === sums.get(file)) log(`same    ${copy}/${file}`)
      else fail(`${copy}/${file} differs: ${sum}`)
    }
  }

  const reader = join(root, NODE_READER)
  const source = existsSync(reader) ? readFileSync(reader, 'utf8') : ''
  if (!source.includes(relative('tools/eventControl', CANONICAL)))
    fail(`${NODE_READER} does not read ${CANONICAL}`)
  else log(`reads   ${CANONICAL} from ${NODE_READER}`)

  log(
    failed
      ? 'event-control contract: FAILED'
      : `event-control contract: ${FILES.length} fixtures, ${copies.length} copies, all identical`
  )
  return failed ? 1 : 0
}

module.exports = { main, FILES, CANONICAL }

if (require.main === module) process.exitCode = main()
