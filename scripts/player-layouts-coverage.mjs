// The coverage gate for the player-layouts work: one player for every video,
// its line score from game events, and live multi-angle playback. Every
// changed runtime line of `src/**/*.ts(x)` since TS_COVERAGE_BASE is
// measured, each file and the total.
//
//   TS_COVERAGE_BASE=$(git merge-base origin/master HEAD) \
//     npm run coverage.playerLayouts -- --unit
//   TS_COVERAGE_BASE=… TS_PLAYER_BROWSER_COVERAGE=coverage/playerLayouts/browser.json \
//     TS_PLAYER_SERVER_COVERAGE=coverage/playerLayouts/server \
//     npm run coverage.playerLayouts
//
// `--unit` is the unit gate, at 90%: the `.test.ts` suites in `tsSuites`, the
// `.test.tsx` suites in `appSuites` (each bundled alone: bundled together
// they interfere, the way `npm test`'s one bundle does) and the native specs
// (`build-player-native-tests.mjs`). Without it the gate is the combined one,
// at 95%: the same unit counters merged with the web end-to-end run's
// browser coverage (istanbul JSON, `TS_PLAYER_BROWSER_COVERAGE`) and the
// end-to-end server's V8 coverage (`NODE_V8_COVERAGE` directory,
// `TS_PLAYER_SERVER_COVERAGE`). A changed file no suite loaded fails.
//
// A milestone that adds a suite adds it to `tsSuites` or `appSuites`. Test
// tooling (`scripts/**`, `src/test/**`), tests, end-to-end files, type
// declarations, migrations and development scripts are not measured.
import { spawnSync } from 'node:child_process'
import {
  cpSync,
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

import { build } from 'esbuild'
import ts from 'typescript'

import {
  buildNativeSpecs,
  runNativeSpecs
} from './build-player-native-tests.mjs'
import { webSettings } from './web-build-settings.mjs'

const unitOnly = process.argv.includes('--unit')
const minimum = unitOnly ? 90 : 95

/** The `.test.ts` suites, run together under mocha. */
const tsSuites = [
  'src/app/player/**/*.test.ts',
  'src/common/api.test.ts',
  'src/common/wallTimeline.test.ts',
  'src/server/openapi.test.ts'
]

/** The `.test.tsx` suites, each bundled alone. */
const appSuites = [
  'src/app/player/PlayerSurface.test.tsx',
  'src/app/player/MultiCamView.test.tsx',
  'src/app/player/MultiCamView.native.test.tsx',
  'src/app/player/scoreboardOverlay/ScoreboardOverlay.test.tsx',
  'src/app/player/scoreboardOverlay/liveBoard.test.tsx',
  'src/app/App.membershipAccess.test.tsx'
]

const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error('Set TS_COVERAGE_BASE to the branch base (git merge-base)')
const report = resolve('coverage/playerLayouts')
const temp = resolve(report, 'tmp')
rmSync(resolve(report, 'tmp'), { recursive: true, force: true })
rmSync(resolve(report, 'coverage-final.json'), { force: true })
mkdirSync(temp, { recursive: true })
const bundles = resolve('lib/playerLayouts-tests')
rmSync(bundles, { recursive: true, force: true })
mkdirSync(bundles, { recursive: true })

const failedSuites = []
function run(command, args, extraEnv = {}) {
  console.log('$', command, ...args)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })
  if (result.status !== 0) failedSuites.push(`${command} ${args.join(' ')}`)
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
  existsSync(path) &&
  !path.endsWith('.d.ts') &&
  !/\.(test|spec|e2e|integration)\./.test(path) &&
  !path.startsWith('src/test/') &&
  !path.startsWith('src/migrate/') &&
  !path.startsWith('src/server/dev/') &&
  path !== 'src/server/db/database.ts' &&
  hasExecutableSource(path)

const changed = lines(git(['diff', '--name-only', '--diff-filter=d', base]))
const untracked = lines(git(['ls-files', '--others', '--exclude-standard']))
const paths = [...new Set([...changed, ...untracked])].filter(eligible).sort()

for (const [index, suite] of appSuites.entries()) {
  await build({
    ...webSettings,
    alias: {
      ...webSettings.alias,
      'react-native-webview': './src/test/eventWebViewStub.tsx',
      'react-native-maps': './src/test/eventNativeMapStub.tsx',
      '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts',
      '@react-native/assets-registry/registry':
        'react-native-web/dist/modules/AssetRegistry'
    },
    stdin: {
      contents: `import './${suite}'`,
      resolveDir: process.cwd(),
      sourcefile: `player-layouts-test-${index}.ts`
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

const mocha = 'node_modules/.bin/mocha'
const setup = ['-r', 'sucrase/register', '-r', './src/test/scoringDomSetup.cjs']
run(
  mocha,
  [
    ...setup,
    '--timeout',
    '60000',
    '--extension',
    'ts',
    ...tsSuites.flatMap(spec => ['--spec', spec])
  ],
  { NODE_V8_COVERAGE: temp }
)
for (const [index, suite] of appSuites.entries()) {
  console.log(`\n${suite}`)
  run(
    mocha,
    [
      ...setup,
      '--timeout',
      '60000',
      '--exit',
      resolve(bundles, `${index}.cjs`)
    ],
    {
      NODE_V8_COVERAGE: temp
    }
  )
}
const native = await buildNativeSpecs(resolve('lib/playerLayouts-native'))
if (!runNativeSpecs(native, { NODE_V8_COVERAGE: temp }))
  failedSuites.push('the native specs')

// The end-to-end server's counters join the unit ones before the report.
const serverCoverage = process.env.TS_PLAYER_SERVER_COVERAGE
if (!unitOnly && serverCoverage != null && existsSync(serverCoverage))
  for (const file of readdirSync(serverCoverage))
    cpSync(resolve(serverCoverage, file), resolve(temp, `server-${file}`))

// Bundled sources are file URLs in the recorded source maps; c8 wants paths.
for (const file of readdirSync(temp)) {
  const location = resolve(temp, file)
  const data = JSON.parse(readFileSync(location, 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {}))
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  writeFileSync(location, JSON.stringify(data))
}

const require = createRequire(import.meta.url)
const { createCoverageMap } = require('istanbul-lib-coverage')
let map = createCoverageMap({})
if (paths.length > 0) {
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
    '**/*.spec.*',
    '--exclude',
    '**/*.e2e.*',
    '--exclude',
    'src/test/**'
  ])
  map = createCoverageMap(
    JSON.parse(readFileSync(resolve(report, 'coverage-final.json'), 'utf8'))
  )
}
const browserCoverage = process.env.TS_PLAYER_BROWSER_COVERAGE
if (!unitOnly && browserCoverage != null)
  map.merge(JSON.parse(readFileSync(browserCoverage, 'utf8')))
writeFileSync(
  resolve(report, 'coverage-final.json'),
  JSON.stringify(map.toJSON())
)

const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
let diff =
  paths.length > 0 ? git(['diff', '--unified=0', base, '--', ...paths]) : ''
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
for (const path of paths)
  if (map.files().includes(resolve(path)))
    counts[path] = istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
const result = lineReportFromCounts(
  changedLines(diff),
  counts,
  path => paths.includes(path),
  { min: minimum }
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

const short = rows.filter(row => row.percent < minimum)
const failures = [
  ...failedSuites.map(suite => `failed: ${suite}`),
  ...short.map(row => `${row.path} is at ${row.percent.toFixed(1)}%`),
  ...result.missing.map(path => `${path} was never loaded`),
  ...(result.total > 0 && result.percent < minimum
    ? [`the total is at ${result.percent.toFixed(2)}%`]
    : [])
]
const kind = unitOnly ? 'unit' : 'combined'
const summary =
  result.total === 0
    ? `Player layouts ${kind} coverage: no changed runtime lines since ${base}`
    : `Player layouts ${kind} changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total} lines) over ${rows.length} files, base ${base}`
if (failures.length > 0) {
  console.error(`\n${summary}\nBelow ${minimum}%: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`\n${summary}`)
