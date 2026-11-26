// The coverage gate for sponsor features: the shared rules and limits, the
// server's upload checks, credits, rows and sample video, the league-admin
// sponsor API, and every edited existing file they reach. Every changed
// runtime line of `src/**/*.ts(x)` since TS_COVERAGE_BASE is measured, each
// file and the total, at 90%.
//
//   TS_COVERAGE_BASE=$(git merge-base origin/develop HEAD) \
//   TS_TEST_DATABASE_URL=postgres://localhost:5433/postgres \
//     npm run coverage.sponsors [-- --browser <coverage.json>] [-- --native]
//
// The `.test.ts` suites in `tsSuites` run together under mocha; each
// `.test.tsx` in `appSuites` is bundled alone, as the web build resolves it;
// each `.native.spec.tsx` in `nativeSuites` is bundled alone with the native
// stand-ins `scripts/build-player-native-tests.mjs` uses and the sponsor
// files' `.native` twins; and each
// `*.integration.test.ts` in `integrationSuites` runs under mocha against
// TS_TEST_DATABASE_URL and TS_TEST_REDIS_URL, after the scheduler and chat
// crypto builds. Any failing suite fails the run, so it is also the work's
// test command. A changed file no suite loaded fails.
//
// `--browser <coverage.json>` merges an end-to-end run's browser counters
// (from `npm run e2e -- coverage-merge`) into the unit counters, and the
// combined counters must then also reach 95%, per file and in total.
// `--native` runs the phones' own gate, `scripts/sponsor-coverage-native.mjs`.
//
// It never deletes or overwrites a file. Each run writes into fresh
// directories named for its UTC start stamp, `coverage/sponsors/<stamp>/`
// and `lib/sponsors-tests/<stamp>/`, and refuses, naming the path, when
// either already exists. Source maps it rewrites go to new files in
// `<stamp>/fixed/`.
//
// A milestone that adds a suite, or whose edit reaches an existing one, adds
// it to its list. Test tooling (`scripts/**`, `src/test/**`), tests,
// end-to-end files and type declarations are not measured.
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
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { sponsorNativePlugin } from './sponsorNativePlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

const unitMinimum = 90
const combinedMinimum = 95

/** The `.test.ts` suites, run together under mocha. */
const tsSuites = [
  // The rules, the limits, the client and the server's checks (M1).
  'src/common/sponsors/sponsorRules.test.ts',
  'src/common/sponsors/limits.test.ts',
  'src/common/api.sponsors.test.ts',
  'src/server/sponsors/imageHeader.test.ts',
  'src/server/sponsors/probe.test.ts',
  'src/server/backgroundJobs.test.ts',
  'src/server/jsonBody.unit.test.ts',
  'src/server/openapi.test.ts',
  // The closed list of server modules errors may name.
  'src/common/observability/errors.test.ts',
  // The admin screens' store, shrinking, picking and placing (M2).
  'src/app/sponsors/apiSponsorStore.test.ts',
  'src/app/sponsors/prepareMedia.test.ts',
  'src/app/sponsors/prepareMedia.native.test.ts',
  'src/app/sponsors/pickedFiles.test.ts',
  'src/app/sponsors/pickedFiles.native.test.ts',
  'src/app/sponsors/routes.test.ts',
  'src/app/player/sponsors/overlayRects.test.ts',
  // When a half-inning is over, the reels' timeline and audio, the layouts'
  // reel spaces and the players' volume (M4).
  'src/common/sponsors/halves.test.ts',
  'src/app/player/sponsors/reelTimeline.test.ts',
  'src/app/player/multiCam/playerLayout.test.ts',
  'src/app/tv/tvLayout.test.ts',
  'src/app/tv/playbackState.test.ts',
  'src/app/player/nativeVideoHandle.test.ts',
  'src/server/routes/gameWritten.test.ts',
  // Which league's sponsorship each viewer sees (M5).
  'src/server/sponsors/eligibility.test.ts',
  // Sponsored rows placed among a Schedule's games (M6).
  'src/app/sponsors/sponsoredRows.test.ts',
  // The sponsor events' contract, the row view timers and the random id the
  // TV's analytics use without the device's storage (M7).
  'src/common/observability/contract.test.ts',
  'src/app/sponsors/viewTimers.test.ts',
  'src/app/stream/randomUuid.test.ts',
  'src/app/stream/deviceId.test.ts',
  // Where the node places sponsor logos and reels, and its sample (M8).
  'src/common/nodeSettings.test.ts'
]

/** The `.test.tsx` suites, each bundled alone. */
const appSuites = [
  // The admin screens on the API store, on the web (M2).
  'src/app/sponsors/SponsorLogosScreen.test.tsx',
  'src/app/sponsors/SponsorReelsScreen.test.tsx',
  'src/app/sponsors/SponsorEventStreamScreen.test.tsx',
  'src/app/sponsors/SponsorSampleVideo.test.tsx',
  'src/app/sponsors/SponsorFileDrop.test.tsx',
  'src/app/sponsors/SponsorFileDrop.native.test.tsx',
  'src/app/sponsors/SponsoredScheduleRow.test.tsx',
  'src/app/screens/GroupSettingsScreen.test.tsx',
  'src/app/App.sponsors.test.tsx',
  // The game's sponsorship, read and kept up to date, and its logo on the
  // card, on every tile of the grids and on every TV camera (M3).
  'src/app/player/sponsors/useGameSponsors.test.tsx',
  'src/app/player/PlayerSurface.test.tsx',
  'src/app/player/MultiCamView.test.tsx',
  'src/app/player/MultiCamView.native.test.tsx',
  'src/app/tv/TvPlayer.test.tsx',
  // The reel on the game's clock, the game's sound under it, the grid's
  // heard tile and the TV's camera volume (M4).
  'src/app/player/sponsors/SponsorReel.test.tsx',
  'src/app/player/sponsors/useGameVolume.test.tsx',
  'src/app/player/multiCam/useMultiCam.test.tsx',
  'src/app/tv/TransportVideo.test.tsx',
  // Sponsored rows in the combined, team, public team and season Schedules,
  // and the paged lists' complete start (M6).
  'src/app/screens/GamesFeedScreen.test.tsx',
  'src/app/screens/TeamScreen.test.tsx',
  'src/app/screens/teamSchedule.test.tsx',
  'src/app/screens/PublicTeamContent.test.tsx',
  'src/app/screens/SeasonPresentation.test.tsx',
  'src/app/hooks/usePagedList.test.tsx',
  // Reel views, row views and taps, the lists' viewable rows, the provider's
  // store and the TV's provider (M7).
  'src/app/player/sponsors/useReelViews.test.tsx',
  'src/app/sponsors/sponsorRowEvents.test.tsx',
  'src/app/components/PagedList.test.tsx',
  'src/app/components/PagedList.native.test.tsx',
  'src/app/observability/AnalyticsContext.test.tsx',
  'src/app/tv/TvApp.test.tsx',
  // The node administrator's sponsor settings and sample upload (M8).
  'src/app/screens/NodeSettingsCard.test.tsx'
]

/**
 * The native specs, each bundled alone with the native stand-ins and the
 * sponsor files' `.native` twins (`scripts/sponsorNativePlugin.mjs`).
 */
const nativeSuites = [
  // The same screens as a phone resolves them (M2).
  'src/app/sponsors/SponsorScreens.native.spec.tsx',
  // The reel and the game's volume as a phone and the TV play them (M4).
  'src/app/player/sponsors/SponsorReel.native.spec.tsx',
  'src/app/player/VideoView.native.spec.tsx'
]

/**
 * The integration suites, each run alone against the test database. `grep`
 * keeps a suite to the cases this work owns, where the file holds others.
 */
const integrationSuites = [
  // The schema, the API, the sample video and the new-league grant (M1).
  { spec: 'src/migrate/migrations/131sponsorFeatures.integration.test.ts' },
  { spec: 'src/server/routes/sponsors.integration.test.ts' },
  { spec: 'src/server/sponsors/sample.integration.test.ts' },
  { spec: 'src/server/groups/directActions.integration.test.ts' },
  // The sponsors world (U6a), beside the fixture CLI's key checks.
  {
    spec: 'src/server/dev/fixtures/fixtures.integration.test.ts',
    grep: 'sponsors gives|refuses to run without a mailbox'
  },
  // The playback answer, moved out of the route.
  { spec: 'src/server/routes/hlsPlayback.integration.test.ts' },
  { spec: 'src/server/routes/mediaPlaylist.integration.test.ts' },
  // The server's start and stop, with the sweeps and the routes mounted.
  { spec: 'src/server/serverStart.integration.test.ts' },
  // A game's logo, from its first recording to its charge, and the calls
  // that give it: the first publish and an ingest (M3).
  { spec: 'src/server/sponsors/logos.integration.test.ts' },
  { spec: 'src/server/live/startController.integration.test.ts' },
  { spec: 'src/server/media/ingestFile.integration.test.ts' },
  // Reels placed before games and after half-innings, and the hook the
  // scoring and lineup posts call (M4).
  { spec: 'src/server/sponsors/reels.integration.test.ts' },
  // Each viewer's league: their team's, or the hash's for a neutral one (M5).
  { spec: 'src/server/sponsors/eligibility.integration.test.ts' },
  {
    spec: 'src/server/routes/events.integration.test.ts',
    grep: 'U21 the half-inning'
  },
  {
    spec: 'src/server/routes/lineups.integration.test.ts',
    grep: 'U21'
  },
  // The rows each Schedule reads, and who may read them (M6).
  { spec: 'src/server/sponsors/rows.integration.test.ts' },
  // The sponsor events stored, signed in and out (M7).
  { spec: 'src/server/observability/analytics.integration.test.ts' },
  // The node's sponsor placements and its sample video upload (M8).
  { spec: 'src/server/nodeSettings.integration.test.ts' },
  { spec: 'src/server/routes/nodeSampleVideo.integration.test.ts' }
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
if (process.argv.includes('--native')) {
  const nativeGate = resolve('scripts/sponsor-coverage-native.mjs')
  if (!existsSync(nativeGate))
    throw new Error(`--native needs ${nativeGate}, which is not here yet`)
  const result = spawnSync(process.execPath, [nativeGate], {
    stdio: 'inherit'
  })
  process.exit(result.status ?? 1)
}
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
const report = freshDirectory(resolve('coverage/sponsors', stamp))
const bundles = freshDirectory(resolve('lib/sponsors-tests', stamp))
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

/**
 * The TV's remote reads its events from the test's runtime, as the unit
 * bundles have it (`scripts/build-scoring-tests.mjs`).
 */
function tvRemoteRuntimePlugin() {
  return {
    name: 'tv-remote-runtime',
    setup(build) {
      build.onLoad({ filter: /app\/tv\/remote\.ts$/ }, args => ({
        contents: readFileSync(args.path, 'utf8').replace(
          "import * as ReactNative from 'react-native'",
          "import * as ReactNative from '../../test/tvRemoteRuntime'"
        ),
        loader: 'ts'
      }))
    }
  }
}

/** Bundles `suite` alone into `outfile`, natively when `native`. */
async function bundle(suite, outfile, native) {
  console.log(`$ esbuild ${suite} -> ${outfile}`)
  await build({
    ...webSettings,
    plugins: [
      ...webSettings.plugins,
      tvRemoteRuntimePlugin(),
      // A DOM with no layout draws a list's rows only through the stand-in,
      // as `npm test` bundles the Schedule screens' suites.
      pagedListStandInPlugin(),
      ...(native ? [sponsorNativePlugin()] : [])
    ],
    alias: {
      ...webSettings.alias,
      'react-native/Libraries/Utilities/DevLoadingView':
        './src/test/tvDevLoadingStub.ts',
      'react-native-webview': './src/test/eventWebViewStub.tsx',
      'react-native-maps': './src/test/eventNativeMapStub.tsx',
      '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts',
      '@react-native/assets-registry/registry':
        'react-native-web/dist/modules/AssetRegistry',
      ...(native
        ? {
            'react-native-video': resolve(
              'src/test/stubs/reactNativeVideo.tsx'
            ),
            'react-native-image-picker': resolve(
              'src/test/stubs/reactNativeImagePicker.ts'
            ),
            '@react-native-documents/picker': resolve(
              'src/test/stubs/reactNativeDocumentsPicker.ts'
            )
          }
        : {})
    },
    stdin: {
      contents: `import './${suite}'`,
      resolveDir: process.cwd(),
      sourcefile: `sponsor-test-${outfile.replace(/.*\//, '')}.ts`
    },
    outfile,
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
const bundled = []
for (const [index, suite] of appSuites.entries()) {
  const outfile = resolve(bundles, `app-${index}.cjs`)
  await bundle(suite, outfile, false)
  bundled.push({ suite, outfile })
}
for (const [index, suite] of nativeSuites.entries()) {
  const outfile = resolve(bundles, `native-${index}.cjs`)
  await bundle(suite, outfile, true)
  bundled.push({ suite, outfile })
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
for (const { suite, outfile } of bundled) {
  console.log(`\n${suite}`)
  run(mocha, [...setup, '--timeout', '60000', '--exit', outfile], {
    NODE_V8_COVERAGE: temp
  })
}
if (integrationSuites.length > 0) {
  for (const args of [
    ['scripts/schedulerBuild.mjs', 'node'],
    ['scripts/chatCryptoBuild.mjs', 'node', 'wasm']
  ]) {
    console.log('$ node', ...args)
    const built = spawnSync(process.execPath, args, { stdio: 'inherit' })
    if (built.status !== 0) throw new Error(`node ${args.join(' ')} failed`)
  }
}
for (const { spec, grep } of integrationSuites) {
  console.log(`\n${spec}`)
  run(
    mocha,
    [
      ...setup,
      '--timeout',
      '120000',
      '--exit',
      '--extension',
      'ts',
      ...(grep == null ? [] : ['--grep', grep]),
      spec
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
        ? ' NODE_OPTIONS has --permission (as under `socket npm`), which stops V8 writing coverage; run `npm run coverage.sponsors` without socket.'
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
      ? `Sponsor ${name} coverage: no changed runtime lines since ${base}`
      : `Sponsor ${name} changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total} lines) over ${rows.length} files, base ${base}`
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
  console.error(`\nSponsor coverage failed: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`\nSponsor coverage passed; reports in ${report}`)
