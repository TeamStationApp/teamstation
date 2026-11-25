const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')

// The Git tree covers every tracked input, including tests and lockfiles. A
// completely staged tree can be measured before committing it.
function coverageSource() {
  const git = args => execFileSync('git', args, { encoding: 'utf8' })
  if (
    git(['diff', '--name-only', '-z']) !== '' ||
    git(['ls-files', '--others', '--exclude-standard', '-z']) !== ''
  )
    throw new Error('Stage all source changes before measuring coverage')
  return createHash('sha256')
    .update(git(['write-tree']).trim())
    .digest('hex')
}

// Direct diffs for both gates start at TS_COVERAGE_BASE, as the other
// coverage scripts do, or else where this branch diverged from develop.
function coverageBase() {
  const base = process.env.TS_COVERAGE_BASE
  const ref = base == null || base === '' ? 'origin/develop' : base
  return execFileSync('git', ['merge-base', ref, 'HEAD'], {
    encoding: 'utf8'
  }).trim()
}

module.exports = { coverageBase, coverageSource }
