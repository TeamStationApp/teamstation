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

const serverOnly = false
const combinedMinimum = process.argv.includes('--unit') ? 90 : 95
const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error('Supply TS_COVERAGE_BASE for the concurrent scoring commits')
const report = resolve(
  'coverage/concurrentScoring',
  process.argv.includes('--unit') ? 'unit' : 'combined'
)
rmSync(report, { recursive: true, force: true })
const temp = resolve(report, 'tmp')
mkdirSync(temp, { recursive: true })
const failedSuites = []
function run(command, args, env = {}, collectFailure = false) {
  console.log('$', command, ...args)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) {
    if (!collectFailure) process.exit(result.status ?? 1)
    failedSuites.push(`${command} ${args.join(' ')}`)
  }
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
  ...new Set([...git(['diff', '--name-only', base]).split('\n'), ...untracked])
].filter(path =>
  /^src\/app\/scoring\/(ScoringScreen\.tsx|scoringFollow\.ts|scoringMachine\.ts|scoringFlow\.ts)$/.test(
    path
  )
)

if (!serverOnly) {
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
      '--exit',
      'lib/scoring-tests.cjs',
      '--grep',
      'scoring|scorer|scorekeeper|game socket|roster sheet|offline'
    ],
    { NODE_V8_COVERAGE: temp },
    true
  )
}
run(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '--timeout',
    '60000',
    '--exit',
    'src/app/scoring/*.test.ts',
    'src/common/scoring/*.test.ts'
  ],
  { NODE_V8_COVERAGE: temp },
  true
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
  '--reporter=text',
  '--reporter=json',
  '--reports-dir',
  report,
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
const map = require('istanbul-lib-coverage').createCoverageMap(
  JSON.parse(readFileSync(resolve(report, 'coverage-final.json'), 'utf8'))
)
// Optional measured browser counters must describe these exact source bytes.
if (process.env.TS_DIRECT_BROWSER_COVERAGE != null) {
  if (process.argv.includes('--unit'))
    throw new Error('Unit gate cannot use browser coverage')
  const browser = JSON.parse(
    readFileSync(process.env.TS_DIRECT_BROWSER_COVERAGE, 'utf8')
  )
  const revision = git(['rev-parse', 'HEAD'])
  if (browser.revision !== revision || git(['diff', '--', ...paths]) !== '')
    throw new Error(
      'Browser coverage must match the clean tested source revision'
    )
  map.merge(browser.coverage)
}
writeFileSync(
  resolve(report, 'coverage-final.json'),
  JSON.stringify(map.toJSON())
)
let diff = git(['diff', '--unified=0', base, '--', ...paths])
for (const path of untracked.filter(path => paths.includes(path))) {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
}
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts,
  withoutTypeOnlyLines
} = require('./changed-line-coverage.cjs')
const counts = {}
for (const path of paths)
  if (map.files().includes(resolve(path)))
    counts[path] = withoutTypeOnlyLines(
      path,
      readFileSync(path, 'utf8'),
      istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
    )
const result = lineReportFromCounts(
  changedLines(diff),
  counts,
  path => paths.includes(path),
  { min: combinedMinimum }
)
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify(result, null, 2)
)
const failures = []
for (const [path, lines] of Object.entries(result.files)) {
  const total = lines.covered.length + lines.uncovered.length
  if (total === 0) continue
  const percent = (lines.covered.length / total) * 100
  console.log(
    `${path}: ${percent.toFixed(2)}% (${lines.covered.length}/${total})${lines.uncovered.length ? ' uncovered ' + lines.uncovered.join(',') : ''}`
  )
  if (percent < combinedMinimum) failures.push(path)
}
console.log(
  `Concurrent scoring changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total})`
)
if (failedSuites.length)
  console.error('Test suites failed:', failedSuites.join('\n'))
if (
  failedSuites.length ||
  failures.length ||
  !result.pass ||
  result.total === 0
)
  throw new Error(
    `At least ${combinedMinimum}% combined changed runtime coverage required: ${failures.join(', ')}; missing: ${result.missing.join(', ')}`
  )
