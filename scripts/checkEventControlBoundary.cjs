const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

// Device event control is app-neutral: no receiver is special, and nothing on
// the Director's side may know what app a receiver is. This check keeps any
// one app's name out of the shared code:
//
//   node scripts/checkEventControlBoundary.cjs
//
// It fails on a case-insensitive substring match of a forbidden word in
//   (a) every file under the neutral event-control trees, and
//   (b) every line this branch adds (`git diff origin/master...HEAD`) under the
//       Director, Cameraman and shared mobile trees.
// Lines already on master are not scanned.

const ROOT = join(__dirname, '..')
// Each forbidden word is held only as its length and the SHA-256 (hex) of its
// lower-cased UTF-8 text, so this file names nothing. A scanned text is
// lower-cased and every substring of that length is hashed and compared.
const FORBIDDEN = [
  {
    length: 7,
    sha256: '0e7f3c5c909ce8afb978a208d639e85af2171df2ec0003a07f13ad97878ef053'
  }
]

const NEUTRAL_TREES = [
  'mobile/apps/common/EventControl',
  'tools/eventControl'
]
// Android's neutral package directory, wherever under the app it sits.
const NEUTRAL_DIRECTORY_NAME = 'eventcontrol'
const ANDROID_APP = 'mobile/apps/tsCameramanAndroid'
const ADDED_LINE_TREES = [
  'mobile/apps/tsDirector',
  'mobile/apps/tsCameraman',
  'mobile/apps/tsCameramanAndroid',
  'mobile/apps/common'
]

/** Whether the lower-cased text contains any forbidden word. */
function names(text, forbidden = FORBIDDEN) {
  const lower = text.toLowerCase()
  return forbidden.some(({ length, sha256 }) => {
    for (let at = 0; at + length <= lower.length; at++) {
      const digest = createHash('sha256')
        .update(lower.slice(at, at + length), 'utf8')
        .digest('hex')
      if (digest === sha256) return true
    }
    return false
  })
}

function git(args, root) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
}

/** Every tracked or untracked, not ignored, file under the neutral trees. */
function neutralFiles(root) {
  const listed = git(
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...NEUTRAL_TREES,
      ANDROID_APP
    ],
    root
  )
    .split('\n')
    .filter(path => path !== '')
  return [...new Set(listed)].filter(
    path =>
      NEUTRAL_TREES.some(tree => path.startsWith(`${tree}/`)) ||
      path.split('/').slice(0, -1).includes(NEUTRAL_DIRECTORY_NAME)
  )
}

/** `path:line: text` for every added line under the trees that names it. */
function addedLines(root, base, forbidden = FORBIDDEN) {
  const diff = git(
    ['diff', '--unified=0', `${base}...HEAD`, '--', ...ADDED_LINE_TREES],
    root
  )
  const found = []
  let path
  let line = 0
  for (const text of diff.split('\n')) {
    if (text.startsWith('+++ ')) {
      path = text.startsWith('+++ b/') ? text.slice(6) : undefined
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk != null) {
      line = Number(hunk[1])
      continue
    }
    if (text.startsWith('+') && path != null) {
      if (names(text, forbidden))
        found.push(`${path}:${line}: ${text.slice(1).trim()}`)
      line++
    }
  }
  return found
}

function main({
  root = ROOT,
  base = 'origin/master',
  forbidden = FORBIDDEN,
  log = console.log
} = {}) {
  const findings = []
  const files = neutralFiles(root)
  for (const path of files) {
    let text
    try {
      text = readFileSync(join(root, path), 'utf8')
    } catch {
      continue
    }
    if (names(path, forbidden)) findings.push(`${path}: in its path`)
    text.split('\n').forEach((content, index) => {
      if (names(content, forbidden))
        findings.push(`${path}:${index + 1}: ${content.trim()}`)
    })
  }
  const added = addedLines(root, base, forbidden)
  findings.push(...added)
  for (const finding of findings) log(`FAIL ${finding}`)
  log(
    `event-control boundary: ${files.length} neutral files scanned, ` +
      `added lines under ${ADDED_LINE_TREES.join(', ')} scanned since ${base}: ` +
      (findings.length === 0 ? 'clean' : `${findings.length} FAILED`)
  )
  return findings.length === 0 ? 0 : 1
}

module.exports = { main, addedLines, names, neutralFiles }

if (require.main === module) process.exitCode = main()
