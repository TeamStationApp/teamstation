import { execFileSync } from 'node:child_process'
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { transformSync } from 'esbuild'
const require = createRequire(import.meta.url)
const { createCoverageMap } = require('istanbul-lib-coverage')
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
const base =
  process.env.TS_COVERAGE_BASE ??
  execFileSync('git', ['merge-base', 'origin/master', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim()
const untracked = git([
  'ls-files',
  '--others',
  '--exclude-standard',
  '--',
  'src'
])
  .split('\n')
  .filter(Boolean)
const paths = [
  ...new Set([
    ...git(['diff', '--name-only', base, '--', 'src']).split('\n'),
    ...untracked
  ])
]
  .filter(
    p =>
      existsSync(p) &&
      /\.tsx?$/.test(p) &&
      !/\.(test|e2e|integration|fixtures?)\./.test(p) &&
      !p.startsWith('src/test/')
  )
  .filter(
    p =>
      transformSync(readFileSync(p, 'utf8'), {
        loader: p.endsWith('x') ? 'tsx' : 'ts',
        format: 'esm'
      })
        .code.replace(/^\s*(export\s*\{\s*\};?|import\s[^;]*;)\s*$/gm, '')
        .trim() !== ''
  )
const uiOnly = process.argv.includes('--ui-only')
const unitOnly = uiOnly || process.argv.includes('--unit-only')
const unit = createCoverageMap({})
for (const file of [
  'coverage/umpires/coverage-final.json',
  ...(uiOnly ? [] : ['coverage/umpireServer/coverage-final.json'])
])
  unit.merge(JSON.parse(readFileSync(file, 'utf8')))
const combined = createCoverageMap(JSON.parse(JSON.stringify(unit.toJSON())))
const artifacts = process.env.TS_UMPIRE_ARTIFACTS
if (!unitOnly && artifacts == null)
  throw new Error(
    'Supply TS_UMPIRE_ARTIFACTS containing measured browser counters'
  )
for (const file of unitOnly
  ? []
  : globSync(resolve(artifacts, 'support/browser-*.json')))
  combined.merge(JSON.parse(readFileSync(file, 'utf8')))
let diff = git(['diff', '--unified=0', base, '--', ...paths])
for (const file of untracked.filter(p => paths.includes(p))) {
  const lines = readFileSync(file, 'utf8').split('\n').length
  diff += `\ndiff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines} @@\n`
}
const changes = changedLines(diff)
const results = {}
const failures = []
for (const [label, map, min] of [
  ['unit', unit, 90],
  ...(unitOnly ? [] : [['combined', combined, 95]])
]) {
  const counts = {}
  for (const [file, entry] of Object.entries(map.toJSON()))
    counts[resolve(file)] = istanbulCounts(entry)
  const normalized = {}
  for (const file of paths)
    if (counts[resolve(file)] != null) normalized[file] = counts[resolve(file)]
  const result = lineReportFromCounts(
    Object.fromEntries(
      Object.entries(changes).filter(
        ([p]) => !uiOnly || p.startsWith('src/app/')
      )
    ),
    normalized,
    p => paths.includes(p) && (!uiOnly || p.startsWith('src/app/')),
    {
      min,
      newFileMin: min,
      newFiles: paths.filter(
        p =>
          untracked.includes(p) ||
          git(['diff', '--name-only', '--diff-filter=A', base, '--', p]) !== ''
      )
    }
  )
  results[label] = result
  console.log(
    `${label}: ${result.percent.toFixed(2)}% (${result.covered}/${result.total})`
  )
  for (const [path, value] of Object.entries(result.files)) {
    const total = value.covered.length + value.uncovered.length
    const percent = total === 0 ? 100 : (value.covered.length / total) * 100
    if (percent < min) {
      failures.push(`${label} ${path}: ${percent.toFixed(2)}%`)
      console.log(
        `  ${path}: ${percent.toFixed(2)}%, uncovered ${value.uncovered.join(',')}`
      )
    }
  }
  for (const file of result.missing) failures.push(`${label} missing ${file}`)
  if (result.percent < min) failures.push(`${label} total`)
}
writeFileSync(
  'coverage/umpires/combined-final.json',
  JSON.stringify(combined.toJSON())
)
writeFileSync(
  'coverage/umpires/changed-lines.json',
  JSON.stringify(results, null, 2)
)
if (failures.length) throw new Error(failures.join('\n'))
