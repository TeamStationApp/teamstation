const { execFileSync } = require('node:child_process')

const SOURCE = /\.tsx?$/
const NOT_SOURCE = /\.(test|integration|e2e)\./
const ROOTS = ['src/app/', 'src/common/']

// The executable source changed since `base`: added, edited, or moved and
// edited. A file moved without an edit is not a change. The whole tree is
// diffed with rename detection and the roots applied afterwards, because git
// pairs a move only when it can see both sides. Deleted files have no current
// executable lines or source map to account for.
function coverageSources(base, cwd = process.cwd(), rosterEdit = false) {
  const roots = rosterEdit ? [...ROOTS, 'src/server/'] : ROOTS
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' })
  const wanted = path =>
    SOURCE.test(path) &&
    !NOT_SOURCE.test(path) &&
    roots.some(root => path.startsWith(root))
  const fields = git([
    'diff',
    '--name-status',
    '--find-renames',
    '--diff-filter=d',
    '-z',
    base
  ]).split('\0')
  const changed = []
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i]
    if (status.startsWith('R') || status.startsWith('C')) {
      const path = fields[i + 2]
      if (status !== 'R100' && wanted(path)) changed.push(path)
      i += 3
    } else {
      if (wanted(fields[i + 1])) changed.push(fields[i + 1])
      i += 2
    }
  }
  const untracked = git([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    ...roots
  ])
    .split('\0')
    .filter(wanted)
  return { paths: [...new Set([...changed, ...untracked])], untracked }
}
module.exports = { coverageSources }
