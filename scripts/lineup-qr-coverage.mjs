import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformSync } from 'esbuild'

// The lineup QR work's coverage gate (`npm run coverage.lineupQr`). Over every
// production line the branch changes under `src/`, native twins included:
//
// - unit-only changed-line coverage of at least 90%, per file and overall;
// - combined unit and browser coverage of at least 95%, per file and overall,
//   merging measured counters, never percentages. The browser counters are
//   the istanbul map `lineupQrBrowser.e2e.ts` writes, when it has run.
//
// A changed executable file with no counters fails. The base is
// TS_COVERAGE_BASE, else origin/master.
const unitMinimum = 90
const combinedMinimum = 95
const base = process.env.TS_COVERAGE_BASE ?? 'origin/master'
const report = resolve('coverage/lineupQr')
const browserMap = resolve(report, 'browser.json')
const temp = resolve(report, 'tmp')
rmSync(temp, { recursive: true, force: true })
rmSync(resolve(report, 'unit'), { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

const failedSuites = []
function run(command, args, env = {}) {
  console.log('$', command, ...args)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) failedSuites.push(`${command} ${args.join(' ')}`)
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .split('\n')
  .filter(Boolean)
const paths = [
  ...new Set([
    ...git(['diff', '--name-only', base, '--', 'src']).split('\n'),
    ...untracked
  ])
].filter(path => {
  if (
    !existsSync(path) ||
    !/^src\/.+\.tsx?$/.test(path) ||
    /\.(test|e2e|integration|smoke|fixtures?)\./.test(path) ||
    path.startsWith('src/test/') ||
    /\.d\.ts$/.test(path)
  )
    return false
  // A type-only module erases to nothing and has no line to run.
  const { code } = transformSync(readFileSync(path, 'utf8'), {
    loader: path.endsWith('x') ? 'tsx' : 'ts',
    format: 'esm'
  })
  return (
    code.replace(/^\s*(export\s*\{\s*\};?|import\s[^;]*;)\s*$/gm, '').trim() !==
    ''
  )
})
console.log('Lineup QR coverage scope:\n' + paths.join('\n'))
if (paths.length === 0) throw new Error('No changed production files')

// The unit counters: the .tsx suites through the scoring test bundle, and the
// .ts suites through sucrase, one V8 coverage directory for both.
run('node', ['scripts/build-scoring-tests.mjs'])
run(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    '--timeout',
    '60000',
    'lib/scoring-tests.cjs',
    '--grep',
    'lineup QR|roster screen|shimmering text|compact defensive field|scoring slide-up sheets|placeholder count sheet'
  ],
  { NODE_V8_COVERAGE: temp }
)
run(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '--timeout',
    '60000',
    '--extension',
    'ts',
    ...readdirSync('src/app/scoring')
      .filter(name => /^lineupQr.*\.test\.ts$/.test(name))
      .map(name => 'src/app/scoring/' + name)
  ],
  { NODE_V8_COVERAGE: temp }
)
for (const name of readdirSync(temp)) {
  const file = resolve(temp, name)
  const value = JSON.parse(readFileSync(file, 'utf8'))
  for (const map of Object.values(value['source-map-cache'] ?? {}))
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  writeFileSync(file, JSON.stringify(value))
}
run('node_modules/.bin/c8', [
  'report',
  '--all',
  '--temp-directory',
  temp,
  '--reporter=json',
  '--reports-dir',
  resolve(report, 'unit'),
  '--exclude-after-remap',
  ...paths.flatMap(path => ['--include', path]),
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude',
  'src/test/**'
])

const require = createRequire(import.meta.url)
const { createCoverageMap } = require('istanbul-lib-coverage')
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
const unitFile = resolve(report, 'unit', 'coverage-final.json')
const unit = createCoverageMap(
  existsSync(unitFile) ? JSON.parse(readFileSync(unitFile, 'utf8')) : {}
)
const combined = createCoverageMap(unit.toJSON())
if (existsSync(browserMap)) {
  console.log('Merging browser counters from', browserMap)
  combined.merge(JSON.parse(readFileSync(browserMap, 'utf8')))
} else console.log('No browser counters yet: combined is unit-only')
writeFileSync(
  resolve(report, 'coverage-final.json'),
  JSON.stringify(combined.toJSON())
)

let diff = git(['diff', '--unified=0', base, '--', ...paths])
for (const path of untracked.filter(path => paths.includes(path))) {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
}
const changes = changedLines(diff)
const measure = (map, min) => {
  const counts = {}
  for (const path of paths)
    if (map.files().includes(resolve(path)))
      counts[path] = istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
  return lineReportFromCounts(changes, counts, path => paths.includes(path), {
    min
  })
}
const failures = []
const results = {}
for (const [name, map, min] of [
  ['unit', unit, unitMinimum],
  ['combined', combined, combinedMinimum]
]) {
  const result = measure(map, min)
  results[name] = result
  for (const [path, lines] of Object.entries(result.files)) {
    const total = lines.covered.length + lines.uncovered.length
    if (total === 0) continue
    const percent = (lines.covered.length / total) * 100
    console.log(
      `${name} ${path}: ${percent.toFixed(2)}% (${lines.covered.length}/${total})${lines.uncovered.length ? ' uncovered ' + lines.uncovered.join(',') : ''}`
    )
    if (percent < min) failures.push(`${name} ${path}`)
  }
  console.log(
    `Lineup QR ${name} changed-line coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total}), minimum ${min}%`
  )
  if (result.missing.length)
    failures.push(`${name} has no counters for ${result.missing.join(', ')}`)
  if (result.percent < min) failures.push(`${name} overall`)
}
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify(results, null, 2)
)
if (failedSuites.length)
  console.error('Test suites failed:\n' + failedSuites.join('\n'))
if (failedSuites.length || failures.length)
  throw new Error(`Lineup QR coverage failed: ${failures.join('; ')}`)
