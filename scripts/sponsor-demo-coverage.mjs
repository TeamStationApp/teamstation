// The coverage gate for the league administrator's sponsor features demo:
// the mock SponsorStore and its rules, the logos, reels and event stream
// screens, and the League Settings row that opens them. Every changed
// runtime line of `src/**/*.ts(x)` since TS_COVERAGE_BASE is measured, each
// file and the total, at 90%.
//
//   TS_COVERAGE_BASE=$(git merge-base origin/develop HEAD) \
//     npm run coverage.sponsorDemo [-- --browser <coverage.json>]
//
// The `.test.ts` suites in `tsSuites` run together under mocha, and the
// `.test.tsx` suites in `appSuites` are each bundled alone, as the web
// build resolves them. Any failing suite fails the run, so it is also the
// work's test command. A changed file no suite loaded fails.
//
// `--browser <coverage.json>` merges an end-to-end run's browser counters
// (from `npm run e2e -- coverage-merge`) into the unit counters, and the
// combined counters must then also reach 95%, per file and in total.
//
// It never deletes or overwrites a file. Each run writes into fresh
// directories named for its UTC start stamp, `coverage/sponsorDemo/<stamp>/`
// and `lib/sponsorDemo-tests/<stamp>/`, and refuses, naming the path, when
// either already exists. Source maps it rewrites go to new files in
// `<stamp>/fixed/`.
//
// A milestone that adds a suite, or whose edit reaches an existing one, adds
// it to `tsSuites` or `appSuites`. Test tooling (`scripts/**`, `src/test/**`),
// tests, end-to-end files and type declarations are not measured.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import ts from 'typescript'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import { webSettings } from './web-build-settings.mjs'

const unitMinimum = 90
const combinedMinimum = 95

/** The `.test.ts` suites, run together under mocha. */
const tsSuites = [
  // The rules and the mock store (M1).
  'src/app/sponsors/sponsorRules.test.ts',
  'src/app/sponsors/sponsorStore.test.ts',
  // The logos screen's pure parts and its address (M2).
  'src/app/sponsors/overlayBoxes.test.ts',
  'src/app/sponsors/sampleRecording.test.ts',
  'src/app/sponsors/pickedFiles.test.ts',
  'src/app/sponsors/routes.test.ts'
]

/** The `.test.tsx` suites, each bundled alone. */
const appSuites = [
  // The logos screen, its parts, the phone's notice and the app's route (M2).
  'src/app/sponsors/SponsorSampleVideo.test.tsx',
  'src/app/sponsors/SponsorFileDrop.test.tsx',
  'src/app/sponsors/SponsorLogosScreen.test.tsx',
  'src/app/sponsors/SponsorScreens.native.test.tsx',
  'src/app/App.sponsors.test.tsx',
  // The reels screen (M3).
  'src/app/sponsors/SponsorReelsScreen.test.tsx'
]

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  const value = process.argv[index + 1]
  if (value == null || value.startsWith('--'))
    throw new Error(`${name} wants a path`)
  return resolve(value)
}
const browserFile = argument('--browser')
if (browserFile != null && !existsSync(browserFile))
  throw new Error(`No browser coverage at ${browserFile}`)

const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error('Set TS_COVERAGE_BASE to the branch base (git merge-base)')

/** A new directory; refuses, naming it, when it is already there. */
function freshDirectory(path) {
  if (existsSync(path))
    throw new Error(`${path} already exists; this run will not reuse it`)
  mkdirSync(path, { recursive: true })
  return path
}
/** Writes a new file; refuses, naming it, when it is already there. */
function writeNew(path, contents) {
  if (existsSync(path))
    throw new Error(`${path} already exists; this run will not overwrite it`)
  writeFileSync(path, contents, { flag: 'wx' })
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z')
const report = freshDirectory(resolve('coverage/sponsorDemo', stamp))
const bundles = freshDirectory(resolve('lib/sponsorDemo-tests', stamp))
const temp = freshDirectory(resolve(report, 'tmp'))
const fixed = freshDirectory(resolve(report, 'fixed'))
const unitReport = resolve(report, 'unit')
console.log(`Writing to ${report} and ${bundles}`)

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
  console.log('$ git', ...args)
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
  hasExecutableSource(path)

const changed = lines(git(['diff', '--name-only', '--diff-filter=d', base]))
const untracked = lines(git(['ls-files', '--others', '--exclude-standard']))
const paths = [...new Set([...changed, ...untracked])].filter(eligible).sort()

for (const [index, suite] of appSuites.entries()) {
  console.log(`$ esbuild ${suite} -> ${resolve(bundles, `${index}.cjs`)}`)
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
      sourcefile: `sponsor-demo-test-${index}.ts`
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
    loader: ASSET_LOADER
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
    '--exit',
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
    { NODE_V8_COVERAGE: temp }
  )
}

// Node's permission model (`--permission`, which `socket npm` puts in
// NODE_OPTIONS) stops V8 writing its coverage, so nothing would be measured.
const records = readdirSync(temp)
if (records.length === 0) {
  const permission = /--permission\b/.test(process.env.NODE_OPTIONS ?? '')
  console.error(
    `\nNo V8 coverage was written to ${temp}.` +
      (permission
        ? ' NODE_OPTIONS has --permission (as under `socket npm`), which stops V8 writing coverage; run `npm run coverage.sponsorDemo` without socket.'
        : '')
  )
  process.exit(1)
}

// Bundled sources are file URLs in the recorded source maps; c8 wants paths.
// Each record is rewritten to a new file under `fixed/`.
for (const file of records) {
  const data = JSON.parse(readFileSync(resolve(temp, file), 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {}))
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  writeNew(resolve(fixed, file), JSON.stringify(data))
}

const require = createRequire(import.meta.url)
const { createCoverageMap } = require('istanbul-lib-coverage')
let unit = createCoverageMap({})
if (paths.length > 0) {
  run('node_modules/.bin/c8', [
    'report',
    '--temp-directory',
    fixed,
    '--reporter=json',
    '--reports-dir',
    unitReport,
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
  const unitFile = resolve(unitReport, 'coverage-final.json')
  if (existsSync(unitFile))
    unit = createCoverageMap(JSON.parse(readFileSync(unitFile, 'utf8')))
}
let combined = null
if (browserFile != null) {
  console.log(`Merging browser counters from ${browserFile}`)
  combined = createCoverageMap(unit.toJSON())
  combined.merge(JSON.parse(readFileSync(browserFile, 'utf8')))
  writeNew(
    resolve(report, 'combined-coverage.json'),
    JSON.stringify(combined.toJSON())
  )
}

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
const changes = changedLines(diff)

/** Prints one measured table and returns its failures. */
function measure(name, map, min) {
  const counts = {}
  for (const path of paths)
    if (map.files().includes(resolve(path)))
      counts[path] = istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
  const result = lineReportFromCounts(
    changes,
    counts,
    path => paths.includes(path),
    { min }
  )
  writeNew(
    resolve(report, `${name}-changed-lines.json`),
    JSON.stringify(result, null, 2)
  )
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
    `\n${name}, minimum ${min}%\n${'File'.padEnd(width)}      Lines      %  Uncovered changed lines`
  )
  for (const row of rows)
    console.log(
      `${row.path.padEnd(width)}  ${`${row.covered}/${row.total}`.padStart(9)}  ${row.percent.toFixed(1).padStart(5)}  ${row.uncovered.join(', ')}`
    )
  for (const path of result.missing)
    console.log(`${path.padEnd(width)}  never loaded by any suite`)
  const summary =
    result.total === 0
      ? `Sponsor demo ${name} coverage: no changed runtime lines since ${base}`
      : `Sponsor demo ${name} changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total} lines) over ${rows.length} files, base ${base}`
  console.log(summary)
  return [
    ...rows
      .filter(row => row.percent < min)
      .map(row => `${name} ${row.path} is at ${row.percent.toFixed(1)}%`),
    ...result.missing.map(path => `${name} ${path} was never loaded`),
    ...(result.total > 0 && result.percent < min
      ? [`the ${name} total is at ${result.percent.toFixed(2)}%`]
      : [])
  ]
}

const failures = [
  ...failedSuites.map(suite => `failed: ${suite}`),
  ...measure('unit', unit, unitMinimum),
  ...(combined == null ? [] : measure('combined', combined, combinedMinimum))
]
if (failures.length > 0) {
  console.error(`\nSponsor demo coverage failed: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`\nSponsor demo coverage passed; reports in ${report}`)
