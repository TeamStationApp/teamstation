const { execFileSync } = require('node:child_process')

// Deleted files have no current executable lines or source map to account for.
function coverageSources(base, cwd = process.cwd()) {
  const names = args =>
    execFileSync('git', args, { cwd, encoding: 'utf8' })
      .split('\0')
      .filter(path => /\.tsx?$/.test(path) && !/\.(test|e2e)\./.test(path))
  const changed = names([
    'diff',
    '--name-only',
    '--diff-filter=d',
    '-z',
    base,
    '--',
    'src2/app'
  ])
  const untracked = names([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    'src2/app'
  ])
  return { paths: [...new Set([...changed, ...untracked])], untracked }
}
module.exports = { coverageSources }
