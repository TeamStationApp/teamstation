// The coverage gate for the Season Auto-Scheduler: venues and fields, games
// on fields, season scheduling settings and the scheduler. Every changed
// runtime line of `src/**/*.ts(x)` since TS_COVERAGE_BASE is measured, each
// file and the total, and every file the branch adds on its own.
//
//   TS_COVERAGE_BASE=$(git merge-base origin/master HEAD) \
//     npm run coverage.autoScheduler -- --unit
//   TS_COVERAGE_BASE=… \
//     TS_AUTO_SCHEDULER_BROWSER_COVERAGE=coverage/autoScheduler/browser.json \
//     TS_AUTO_SCHEDULER_SERVER_COVERAGE=coverage/autoScheduler/server \
//     npm run coverage.autoScheduler
//
// `--unit` is the unit gate, at 90%: the `.test.ts` suites in `tsSuites` and
// the `.test.tsx` suites in `appSuites`, each bundled alone. Without it the
// gate is the combined one, at 95% per changed file, overall and for each
// added file: the same unit counters merged with the web end-to-end run's
// browser coverage (istanbul JSON) and the end-to-end process's V8 coverage
// (its NODE_V8_COVERAGE directory). Counters are merged, never percentages.
// A changed file no suite loaded fails.
//
// Migrations are measured: their up and down tests load them. Test code,
// `src/test/**`, end-to-end files, fixtures, type-only declarations and the
// server's entry point (`src/server/index.ts`) are not. A milestone that
// adds a suite adds it here.
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

import { webSettings } from './web-build-settings.mjs'

const unitOnly = process.argv.includes('--unit')
const minimum = unitOnly ? 90 : 95

/** The `.test.ts` suites, run together under mocha. */
const tsSuites = [
  // M1: the venue registry, availability and ownership.
  'src/migrate/migrations/077venues.test.ts',
  'src/common/fieldAvailability.test.ts',
  'src/common/calendarDates.test.ts',
  'src/common/eventSchedule.test.ts',
  'src/common/venues.test.ts',
  'src/server/venues/ownership.test.ts',
  // M2: the venue API, photos and notifications.
  'src/server/routes/venues.test.ts',
  'src/server/notifications/venueNotifications.test.ts',
  'src/server/location/googlePlaces.test.ts',
  'src/server/media/images.test.ts',
  'src/server/openapi.test.ts',
  'src/server/jsonBody.test.ts',
  'src/common/api.venues.test.ts',
  // M3: the Field Manager, venue and field screens.
  'src/app/platform/currentPosition.test.ts',
  // M4: games on fields, warnings and notifications.
  'src/migrate/migrations/078gameFields.test.ts',
  'src/server/venues/gameFields.test.ts',
  'src/server/admin/mergeTeams.test.ts',
  'src/server/schedule/gameApprovals.test.ts',
  'src/server/events/eventInfo.test.ts',
  'src/server/routes/schedule.test.ts',
  'src/app/screens/gameDraft.fields.test.ts',
  // M5: exhibition teams, season settings and the setup.
  'src/migrate/migrations/079seasonScheduling.test.ts',
  'src/common/schedulingChecks.test.ts',
  'src/server/routes/schedulingSetup.test.ts',
  'src/server/routes/seasonReaders.test.ts',
  'src/server/admin/mergeTeamsSeasonFlags.test.ts',
  'src/common/api.scheduling.test.ts',
  // M6: the scheduler.
  'src/migrate/migrations/080schedulePreviews.test.ts',
  'src/common/autoScheduler/*.test.ts',
  'src/server/routes/schedulePreviews.test.ts',
  'src/server/autoScheduler/publish.test.ts',
  'src/server/autoScheduler/reschedule.test.ts',
  'src/server/autoScheduler/rules.test.ts',
  'src/server/autoScheduler/buildOffThread.test.ts',
  // Fixes M2: a season is dates, scheduled in each field’s local time.
  'src/common/eventTime.test.ts',
  'src/common/seasonScheduling.test.ts',
  'src/server/groups/authority.test.ts',
  'src/server/groups/parentTerms.test.ts',
  // Fixes M5: T-ball as a size of its own, and the add icon in the phone font.
  'src/migrate/migrations/086fieldSizes.test.ts',
  'src/app/components/iconFont.test.ts',
  // Fixes M8: the pin map's Google-only document.
  'src/app/components/pinMapDocument.test.ts',
  // Fixes M9: the field on a game's Info tab, and directions to its point.
  'src/common/eventInfo.test.ts',
  'src/app/platform/eventDirections.test.ts',
  'src/app/platform/eventDirections.web.test.ts'
]

/** The `.test.tsx` suites, each bundled alone. */
const appSuites = [
  // M3: the Field Manager, venue and field screens.
  'src/app/App.fieldManager.test.tsx',
  'src/app/screens/FieldManagerScreen.test.tsx',
  'src/app/screens/VenueScreen.test.tsx',
  'src/app/screens/FieldScreen.test.tsx',
  'src/app/components/PinMap.test.tsx',
  'src/app/components/WeeklyHoursEditor.test.tsx',
  'src/app/platform/currentPosition.native.test.tsx',
  // M4: the game form's Field row and the Info tab's warnings.
  'src/app/screens/GameFormScreen.fieldPicker.test.tsx',
  'src/app/screens/EventInfoTab.test.tsx',
  'src/app/screens/GameFormScreen.create.test.tsx',
  'src/app/screens/GameFormScreen.edit.test.tsx',
  'src/app/components/EventVenueFields.test.tsx',
  // M5: the setup, its grid and a season's detail.
  'src/app/screens/AutoSchedulerScreen.test.tsx',
  'src/app/screens/SeasonScheduleGrid.test.tsx',
  'src/app/screens/ScheduleSeasonScreen.test.tsx',
  // M6: the preview screen.
  'src/app/screens/SchedulePreviewScreen.test.tsx',
  // Fixes M1: the league page's Auto-Scheduler row and the grid's cells.
  'src/app/components/GridNumberCell.test.tsx',
  'src/app/components/WideTable.test.tsx',
  'src/app/screens/LeaguePage.test.tsx',
  // Fixes M4: blackout ranges.
  'src/app/components/BlackoutDatesEditor.test.tsx',
  // Fixes M6: any registry field for a run, through the picker's field mode.
  'src/app/screens/FieldPickerScene.test.tsx',
  // Fixes M9: the native directions to a field's point.
  'src/app/platform/eventDirections.native.test.tsx'
]

const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error('Set TS_COVERAGE_BASE to the branch base (git merge-base)')
const report = resolve('coverage/autoScheduler')
const temp = resolve(report, 'tmp')
rmSync(resolve(report, 'tmp'), { recursive: true, force: true })
rmSync(resolve(report, 'coverage-final.json'), { force: true })
mkdirSync(temp, { recursive: true })
const bundles = resolve('lib/autoScheduler-tests')
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
  !path.startsWith('src/server/dev/') &&
  path !== 'src/server/db/database.ts' &&
  // The server's entry point, which only a deployed server runs; the
  // harnesses mount the same routers. coverage.changed.server leaves it out
  // for the same reason.
  path !== 'src/server/index.ts' &&
  hasExecutableSource(path)

const changed = lines(git(['diff', '--name-only', '--diff-filter=d', base]))
const added = lines(git(['diff', '--name-only', '--diff-filter=A', base]))
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
      '@react-native-community/geolocation': './src/test/geolocationStub.ts',
      '@react-native/assets-registry/registry':
        'react-native-web/dist/modules/AssetRegistry'
    },
    stdin: {
      contents: `import './${suite}'`,
      resolveDir: process.cwd(),
      sourcefile: `auto-scheduler-test-${index}.ts`
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
    '--exit',
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

// The end-to-end server's counters join the unit ones before the report.
const serverCoverage = process.env.TS_AUTO_SCHEDULER_SERVER_COVERAGE
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
const browserCoverage = process.env.TS_AUTO_SCHEDULER_BROWSER_COVERAGE
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
  {
    min: minimum,
    newFileMin: unitOnly ? 90 : 95,
    newFiles: [...added, ...untracked].filter(path => paths.includes(path))
  }
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
  ...(result.shortNewFiles ?? []).map(path => `new file ${path} is short`),
  ...(result.total > 0 && result.percent < minimum
    ? [`the total is at ${result.percent.toFixed(2)}%`]
    : [])
]
const kind = unitOnly ? 'unit' : 'combined'
const summary =
  result.total === 0
    ? `Auto-Scheduler ${kind} coverage: no changed runtime lines since ${base}`
    : `Auto-Scheduler ${kind} changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total} lines) over ${rows.length} files, base ${base}`
if (failures.length > 0) {
  console.error(`\n${summary}\nBelow ${minimum}%: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`\n${summary}`)
