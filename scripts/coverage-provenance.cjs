// Test infrastructure: reject counters that belong to another source revision.
const { execFileSync } = require('node:child_process')
const { isDeepStrictEqual } = require('node:util')

function coverageSource(cwd, base) {
  const git = args =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  if (git(['status', '--porcelain', '--untracked-files=normal']) !== '')
    throw new Error('Coverage requires a clean committed source revision')
  return {
    revision: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    base: git(['rev-parse', base])
  }
}
function verifyCoverageSource(expected, cwd, base) {
  if (!isDeepStrictEqual(expected, coverageSource(cwd, base)))
    throw new Error('Coverage counters belong to a different source revision')
}
module.exports = { coverageSource, verifyCoverageSource }
