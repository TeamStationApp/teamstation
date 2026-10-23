const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { resolve, relative } = require('node:path')
const {
  changedLines,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')

const git = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  }).trim()
const production = path =>
  /\.(ts|tsx|cjs|mjs|swift|kt)$/.test(path) &&
  !/\.(test|spec|e2e|integration)\.|\/Tests\/|\/test\/|\/androidTest\/|Package\.swift$/.test(
    path
  )

function snapshot(cwd = process.cwd()) {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  const base = git(root, ['merge-base', 'origin/master', 'HEAD'])
  const diff = git(root, ['diff', '--unified=0', base])
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
  const changes = changedLines(diff)
  const hash = createHash('sha256')
    .update(git(root, ['rev-parse', 'HEAD']))
    .update(diff)
  for (const path of untracked) {
    const content = readFileSync(resolve(root, path))
    hash.update(path).update(content)
    if (production(path))
      changes[path] = new Set(
        content
          .toString()
          .split('\n')
          .map((_, i) => i + 1)
      )
  }
  const newFiles = [
    ...untracked,
    ...git(root, ['diff', '--name-only', '--diff-filter=A', base])
      .split('\n')
      .filter(Boolean)
  ]
  return { root, stamp: hash.digest('hex'), changes, newFiles }
}

function verifySource(before, after) {
  if (before.stamp !== after.stamp)
    throw new Error('Source changed while collecting coverage')
}

function mergeCounts(...reports) {
  const combined = {}
  for (const report of reports)
    for (const [path, lines] of Object.entries(report)) {
      const target = (combined[path] ??= {})
      for (const [line, hits] of Object.entries(lines))
        target[line] = (target[line] ?? 0) + hits
    }
  return combined
}

function evaluate(changes, counts, newFiles = []) {
  const result = lineReportFromCounts(changes, counts, () => true, {
    min: 95,
    newFileMin: 95,
    newFiles
  })
  const shortFiles = Object.entries(result.files)
    .filter(([, value]) => {
      const total = value.covered.length + value.uncovered.length
      return total > 0 && value.covered.length / total < 0.95
    })
    .map(([path]) => path)
  result.pass = result.pass && shortFiles.length === 0
  return { ...result, shortFiles }
}

function gate(before, rawCounts, include, log = console.log) {
  verifySource(before, snapshot(before.root))
  const counts = {}
  for (const [path, value] of Object.entries(rawCounts))
    counts[relative(before.root, resolve(before.root, path))] = value
  const changes = Object.fromEntries(
    Object.entries(before.changes).filter(
      ([path]) => production(path) && include(path)
    )
  )
  const report = evaluate(changes, counts, before.newFiles)
  for (const [path, value] of Object.entries(report.files)) {
    const total = value.covered.length + value.uncovered.length
    log(
      `${path}: ${total === 0 ? 100 : ((100 * value.covered.length) / total).toFixed(2)}% (${value.covered.length}/${total})`
    )
    if (value.uncovered.length) log(`  Uncovered: ${value.uncovered.join(',')}`)
  }
  for (const path of report.missing) log(`${path}: MISSING COUNTERS`)
  log(
    `Changed lines: ${report.percent.toFixed(2)}% (${report.covered}/${report.total}); ${report.pass ? 'PASS' : 'FAIL'}`
  )
  if (!report.pass)
    throw new Error('Changed executable lines require 95% per file and overall')
  return report
}
module.exports = {
  snapshot,
  verifySource,
  mergeCounts,
  production,
  evaluate,
  gate
}
