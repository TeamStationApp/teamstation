// The coverage gate for adding existing players and the shared player form:
// every changed runtime line of `src/**/*.ts(x)` since TS_COVERAGE_BASE, at
// 95% or better for each file and in total.
//
//   TS_COVERAGE_BASE=origin/master npm run coverage.existingPlayer
//
// Written on the pattern of `guardian-coverage.mjs`. The server suites are
// every `src/**/*.test.ts` (or the ones TS_COVERAGE_SPECS names), after the
// server build (`npm run build`) that the OAuth suite starts. The app suites are the `.test.tsx` files in `appSuites`
// below, each bundled and run on its own. A milestone that changes app code
// adds the suites that cover it to `appSuites`.
//
// Tests, `src/test`, `src/migrate` (migrations are proved by their own tests),
// `src/server/dev` (development seed scripts, which no suite loads),
// `database.ts` (types) and `openapi.ts` (declarations) are not measured.
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

import { build } from 'esbuild'
import ts from 'typescript'

import { webSettings } from './web-build-settings.mjs'

/** The app suites, each bundled alone. Each milestone appends its own. */
const appSuites = [
  'src/app/screens/NotificationsScreen.test.tsx',
  'src/app/screens/BoxScore.test.tsx',
  'src/app/components/StatisticsTable.test.tsx',
  'src/app/screens/expandedStats.test.tsx',
  'src/app/screens/SeasonScreen.test.tsx',
  'src/app/App.teamRoutes.test.tsx',
  'src/app/scoring/EditRosterList.test.tsx',
  'src/app/scoring/rosterFooter.test.tsx',
  'src/app/scoring/placeholderSheets.test.tsx',
  'src/app/scoring/RosterEditor.coach.test.tsx',
  'src/app/scoring/RosterSelector.test.tsx',
  'src/app/scoring/rosterLive.test.tsx',
  'src/app/components/AddPersonGlyph.test.tsx',
  'src/app/hooks/useRosterCandidates.test.tsx',
  'src/app/scoring/ExistingPlayerSheet.test.tsx'
]

/**
 * The server suites: every one, or for a milestone's quicker gate the ones
 * named in TS_COVERAGE_SPECS (comma separated). The final pass runs them all.
 */
const serverSpecs =
  process.env.TS_COVERAGE_SPECS == null
    ? ['src/**/*.test.ts']
    : process.env.TS_COVERAGE_SPECS.split(',').filter(spec => spec !== '')

/** The combined bar AGENTS.md sets for changed lines. */
const MINIMUM = 95

const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error('Set TS_COVERAGE_BASE to the reviewed parent commit')
const report = resolve('coverage/existingPlayer')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
const bundles = resolve('lib/existing-player-tests')
rmSync(bundles, { recursive: true, force: true })
mkdirSync(bundles, { recursive: true })

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
/**
 * A test run that fails does not stop the measurement, as in
 * `server-changed-coverage.mjs`: the figure is still reported, and every run
 * that failed is named at the end so each failure can be held against the
 * base, where some already fail.
 */
const failedRuns = []
function runTests(label, args, extraEnv) {
  const result = spawnSync(args[0], args.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })
  if (result.status !== 0) failedRuns.push(label)
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}
const lines = text => text.split('\n').filter(line => line !== '')

// Type declarations and forwarding exports have no executable source lines.
function hasExecutableSource(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  return source.statements.some(
    statement =>
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isExportDeclaration(statement) &&
      !(
        ts.isImportDeclaration(statement) &&
        statement.importClause?.isTypeOnly === true
      )
  )
}
const eligible = path =>
  /^src\/.+\.tsx?$/.test(path) &&
  !/\.(test|integration|e2e)\./.test(path) &&
  !path.startsWith('src/test/') &&
  !path.startsWith('src/migrate/') &&
  !path.startsWith('src/server/dev/') &&
  path !== 'src/server/db/database.ts' &&
  path !== 'src/server/openapi.ts' &&
  hasExecutableSource(path)

const changed = lines(git(['diff', '--name-only', '--diff-filter=d', base]))
const untracked = lines(git(['ls-files', '--others', '--exclude-standard']))
const paths = [...new Set([...changed, ...untracked])].filter(eligible).sort()
if (paths.length === 0) throw new Error('No changed runtime files to measure')

for (const [index, suite] of appSuites.entries()) {
  await build({
    ...webSettings,
    alias: {
      ...webSettings.alias,
      '@react-native/assets-registry/registry':
        'react-native-web/dist/modules/AssetRegistry'
    },
    stdin: {
      contents: `import './${suite}'`,
      resolveDir: process.cwd(),
      sourcefile: `existing-player-test-${index}.ts`
    },
    outfile: resolve(bundles, `${index}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: true,
    jsx: 'automatic',
    external: [
      'react',
      'react-dom',
      'three',
      '@react-three/fiber',
      '@react-three/test-renderer',
      'jsdom',
      'mocha',
      'chai'
    ],
    define: {
      __DEV__: 'true',
      TS_API_BASE_URL: JSON.stringify('/api/v1'),
      'process.env.TS_SENTRY_DSN': JSON.stringify(''),
      'process.env.NODE_ENV': JSON.stringify('test')
    },
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
  })
}

run('node', ['src/migrate/requirePostgres18.js'])
// The OAuth suite starts the compiled server from lib/server as well as the
// source one.
if (process.env.npm_execpath != null)
  run(process.execPath, [process.env.npm_execpath, 'run', 'build'])
else run('npm', ['run', 'build'])
const mocha = [
  'node_modules/.bin/mocha',
  ['-r', 'sucrase/register', '-r', './src/test/scoringDomSetup.cjs'],
  ['--timeout', '60000']
]
runTests(
  'server suites',
  [
    mocha[0],
    ...mocha[1],
    ...mocha[2],
    '--extension',
    'ts',
    // Every server suite together leaves some handle open; the run is over.
    '--exit',
    ...serverSpecs.flatMap(spec => ['--spec', spec]),
    '--ignore',
    '**/node_modules/**'
  ],
  { NODE_V8_COVERAGE: temp }
)
for (const [index, suite] of appSuites.entries()) {
  console.log(`\n${suite}`)
  runTests(
    suite,
    [mocha[0], ...mocha[1], ...mocha[2], resolve(bundles, `${index}.cjs`)],
    { NODE_V8_COVERAGE: temp }
  )
}

// Bundled sources are file URLs in the recorded source maps; c8 wants paths.
for (const file of readdirSync(temp)) {
  const location = resolve(temp, file)
  const data = JSON.parse(readFileSync(location, 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {})) {
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  }
  writeFileSync(location, JSON.stringify(data))
}
run('node_modules/.bin/c8', [
  'report',
  '--temp-directory',
  temp,
  '--reporter=json',
  '--reports-dir',
  report,
  '--exclude-after-remap',
  ...paths.flatMap(path => ['--include', path]),
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.integration.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude',
  'src/test/**'
])

const require = createRequire(import.meta.url)
const map = require('istanbul-lib-coverage').createCoverageMap(
  JSON.parse(readFileSync(resolve(report, 'coverage-final.json'), 'utf8'))
)
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
let diff = git(['diff', '--unified=0', base, '--', ...paths])
for (const path of untracked.filter(path => paths.includes(path))) {
  const source = readFileSync(path, 'utf8').split('\n')
  const count = source.length - 1
  diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${count} @@\n`
  diff +=
    source
      .slice(0, count)
      .map(line => '+' + line)
      .join('\n') + '\n'
}
const counts = {}
for (const path of paths) {
  if (map.files().includes(resolve(path)))
    counts[path] = istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
}
const result = lineReportFromCounts(changedLines(diff), counts, path =>
  paths.includes(path)
)
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify(result, null, 2)
)

// One row per changed file with changed runtime lines.
const rows = Object.entries(result.files)
  .map(([path, file]) => {
    const total = file.covered.length + file.uncovered.length
    return {
      path,
      covered: file.covered.length,
      total,
      percent: total === 0 ? 100 : (100 * file.covered.length) / total,
      uncovered: file.uncovered.sort((a, b) => a - b)
    }
  })
  .filter(row => row.total > 0)
const width = Math.max(4, ...rows.map(row => row.path.length))
console.log(
  `\n${'File'.padEnd(width)}      Lines      %  Uncovered changed lines`
)
for (const row of rows)
  console.log(
    `${row.path.padEnd(width)}  ${`${row.covered}/${row.total}`.padStart(9)}  ${row.percent.toFixed(1).padStart(5)}  ${row.uncovered.join(', ')}`
  )
for (const path of result.missing)
  console.log(`${path.padEnd(width)}  never loaded by any suite`)

const short = rows.filter(row => row.percent < MINIMUM)
const failures = [
  ...short.map(row => `${row.path} is at ${row.percent.toFixed(1)}%`),
  ...result.missing.map(path => `${path} was never loaded`),
  ...(result.percent < MINIMUM
    ? [`the total is at ${result.percent.toFixed(2)}%`]
    : [])
]
const summary = `Existing-player changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total} lines) over ${rows.length} files, base ${base}`
if (failures.length > 0) {
  if (failedRuns.length > 0)
    console.error(`Test runs with failures: ${failedRuns.join('; ')}`)
  console.error(`\n${summary}\nBelow ${MINIMUM}%: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`\n${summary}`)
if (failedRuns.length > 0)
  console.log(
    `Test runs with failures, to hold against ${base}: ${failedRuns.join('; ')}`
  )
