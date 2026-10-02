import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const includes = JSON.parse(
  readFileSync('src/test/scoringCoveragePaths.json', 'utf8')
)
console.log('Scoring coverage includes:', includes.join('\n'))
const temp = resolve('coverage/tmp')
rmSync(temp, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
const test = spawnSync(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    '--extension',
    'ts',
    '--spec',
    'src/**/*.test.ts',
    '--spec',
    'lib/scoring-tests.cjs',
    '--ignore',
    '**/node_modules/**'
  ],
  { stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: temp } }
)
// Node caches multi-source bundle maps as file URLs. c8's exclusion callback
// compares filesystem paths before resolving each source, otherwise marking
// every bundled function covered. Normalize map identifiers, never counters.
for (const file of readdirSync(temp)) {
  const path = resolve(temp, file)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {})) {
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  }
  writeFileSync(path, JSON.stringify(data))
}
const report = spawnSync(
  'node_modules/.bin/c8',
  [
    'report',
    '--all',
    '--reporter=text',
    '--reporter=json-summary',
    '--reporter=json',
    '--check-coverage',
    '--lines=90',
    ...includes.flatMap(path => ['--include', path]),
    '--exclude',
    '**/*.test.*',
    '--exclude',
    '**/*.e2e.ts',
    '--exclude',
    'src/test/**',
    '--exclude-after-remap'
  ],
  { stdio: 'inherit' }
)
process.exitCode = test.status !== 0 ? (test.status ?? 1) : (report.status ?? 1)

const summary = JSON.parse(
  readFileSync('coverage/coverage-summary.json', 'utf8')
)
const screen = summary[resolve('src/app/screens/GameScreen.tsx')]
if (
  screen == null ||
  screen.functions.total === 0 ||
  Object.keys(summary).length < 2
) {
  console.error(
    'Missing original screen coverage: reject an unmapped bundle report.'
  )
  process.exitCode = 1
}

// Keep the whole changed-source aggregate honest as this plan grows.
const { coverageSources } = createRequire(import.meta.url)(
  './coverage-source-paths.cjs'
)
// The commit this branch was cut from, unless TS_COVERAGE_BASE names another.
// Everything after it is this work.
const base =
  process.env.TS_COVERAGE_BASE ??
  JSON.parse(readFileSync('src/test/scoringCoverageBase.json', 'utf8')).base
const { paths, untracked } = coverageSources(base)

let covered = 0
let total = 0
for (const path of paths) {
  const entry = summary[resolve(path)]
  if (entry == null) {
    // Pure type declarations carry no executable counters.
    const source = readFileSync(path, 'utf8')
    if (source.includes('export function') || source.includes('export const')) {
      console.error('Changed executable source missing from coverage:', path)
      process.exitCode = 1
    }
    continue
  }
  covered += entry.lines.covered
  total += entry.lines.total
}
const changedPercent = total === 0 ? 100 : (100 * covered) / total
console.log(
  `Whole changed-file line coverage: ${changedPercent.toFixed(2)}% (${covered}/${total})`
)
if (changedPercent < 90) process.exitCode = 1

// The scoring library is held to the bar on its own, not only inside totals.
let libraryCovered = 0
let libraryTotal = 0
for (const [path, entry] of Object.entries(summary)) {
  if (!path.startsWith(resolve('src/common/scoring') + '/')) continue
  console.log(
    `  ${path.slice(resolve('.').length + 1)}: ${entry.lines.pct}% (${entry.lines.covered}/${entry.lines.total})`
  )
  libraryCovered += entry.lines.covered
  libraryTotal += entry.lines.total
}
const libraryPercent =
  libraryTotal === 0 ? 100 : (100 * libraryCovered) / libraryTotal
console.log(
  `Scoring library line coverage: ${libraryPercent.toFixed(2)}% (${libraryCovered}/${libraryTotal})`
)
if (libraryPercent < 90) process.exitCode = 1

const changedBase = process.env.TS_COVERAGE_BASE ?? base
if (changedBase != null) {
  const { changedLines, lineReport } = createRequire(import.meta.url)(
    './changed-line-coverage.cjs'
  )
  const diff = spawnSync(
    'git',
    ['diff', '--diff-filter=d', '--unified=0', '--find-renames', changedBase],
    // The checked-in MLB reference files alone pass spawnSync's 1 MB default.
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  )
  if (diff.status !== 0) throw new Error(diff.stderr)
  // The whole tree with rename detection, then these roots: given only the
  // roots, git cannot pair a moved file with its old path and would count
  // every line of it as changed.
  const roots = [
    'src/app/',
    'src/common/',
    'src/server/stats/',
    'src/server/statsBuilder/',
    'src/server/dev/refoldScoredGames.ts',
    'src/server/dev/validateGumbo.ts'
  ]
  const changes = Object.fromEntries(
    Object.entries(changedLines(diff.stdout)).filter(([path]) =>
      roots.some(root => path === root || path.startsWith(root))
    )
  )
  for (const path of untracked)
    changes[path] = new Set(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((_, i) => i + 1)
    )
  for (const path of Object.keys(changes))
    if (!/\.tsx?$/.test(path) || /\.(test|e2e)\./.test(path))
      delete changes[path]
  const raw = JSON.parse(readFileSync('coverage/coverage-final.json', 'utf8'))
  const coverage = Object.fromEntries(
    Object.keys(changes).map(path => [path, raw[resolve(path)]])
  )
  const report = lineReport(changes, coverage, path =>
    /export (function|const|class)|(?:^|\n)const /.test(
      readFileSync(path, 'utf8')
    )
  )
  writeFileSync('coverage/changed-lines.json', JSON.stringify(report, null, 2))
  console.log(
    `Changed executable line coverage: ${report.covered}/${report.total} (${report.percent.toFixed(2)}%)`
  )
  if (!report.pass) {
    console.error('Missing source maps:', report.missing)
    for (const [path, rows] of Object.entries(report.files))
      if (rows.uncovered.length > 0)
        console.error(path + ':' + rows.uncovered.join(','))
    process.exitCode = 1
  }
}
