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

const phase =
  process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) ?? 'finished'
const report = resolve('coverage/eventInfo')
const temp = resolve(report, 'tmp')
const reportOnly = process.argv.includes('--report-only')
if (!reportOnly && phase !== 'ui')
  rmSync(temp, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
const base =
  process.env.TS_COVERAGE_BASE ?? git(['merge-base', 'origin/master', 'HEAD'])
const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .split('\n')
  .filter(Boolean)
// Settings, account and scheduling permissions have their own complete gate.
// This regression gate measures the event-info paths exercised by these suites.
const ownedPaths = new Set([
  'src/server/index.ts',
  'src/server/routes/eventInfo.ts',
  'src/server/location/googleLookupLimits.ts',
  'src/server/location/eventGeocoder.ts',
  'src/server/location/googlePlaces.ts',
  'src/server/location/coordinateTimezone.ts',
  'src/app/components/EventVenueFields.tsx',
  'src/app/components/googleMapDocument.ts',
  'src/app/components/EventMap.tsx',
  'src/app/components/EventMap.native.tsx',
  'src/app/components/EventMap.android.tsx',
  'src/common/eventPlaces.ts',
  'src/app/screens/EventSettingsScreen.tsx',
  'src/app/screens/EventInfoTab.tsx',
  'src/app/screens/EventDetailsForm.tsx',
  'src/common/eventInfo.ts',
  'src/common/eventDetails.ts',
  'src/server/events/eventInfo.ts',
  'src/server/events/eventInfoOpenApi.ts',
  'src/server/events/eventDetails.ts'
])
const paths = [
  ...new Set([...git(['diff', '--name-only', base]).split('\n'), ...untracked])
].filter(
  path =>
    ownedPaths.has(path) &&
    /^src\/(app|common|server)\//.test(path) &&
    /\.tsx?$/.test(path) &&
    !/\.(test|e2e|smoke)\./.test(path) &&
    !/\.d\.ts$/.test(path) &&
    (phase !== 'server' || !path.startsWith('src/app/'))
)
const serverSuites = [
  'src/server/location/coordinateTimezone.test.ts',
  'src/server/location/googleCityTimezone.test.ts',
  'src/server/routes/googleEventLookup.test.ts',
  'src/server/location/googlePlaces.test.ts',
  'src/app/components/googleMapDocument.test.ts',
  'src/test/smokeRecorder.test.ts',
  'src/common/eventInfo.test.ts',
  'src/common/eventDetails.test.ts',
  'src/server/events/eventDetails.test.ts',
  'src/server/notifications/requestInformation.test.ts',
  'src/server/location/eventPlaces.test.ts',
  'src/server/routes/location.test.ts',
  'src/common/eventTime.test.ts',
  'src/common/eventSchedule.test.ts',
  'src/common/api.test.ts',
  'src/common/gameApprovals.test.ts',
  'src/server/events/eventInfo.test.ts',
  'src/server/admin/mergeTeams.test.ts',
  'src/server/location/eventGeocoder.test.ts',
  'src/server/routes/games.test.ts',
  'src/server/routes/seasonReaders.test.ts',
  'src/server/schedule/eventInfoMetadata.test.ts',
  'src/server/schedule/pendingProjection.test.ts',
  'src/server/schedule/gameRefinements.test.ts',
  'src/server/stats/records.test.ts',
  'src/server/openapi.test.ts'
].filter(path => {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
})
if (!reportOnly) {
  run('node', ['src/migrate/requirePostgres18.js'])
  if (phase !== 'ui') {
    run(
      'node_modules/.bin/mocha',
      ['-r', 'sucrase/register', '--timeout', '60000', ...serverSuites],
      { NODE_V8_COVERAGE: temp }
    )
    if (process.env.EVENT_INFO_ARTIFACTS == null)
      throw new Error('Set EVENT_INFO_ARTIFACTS to the plan artifact directory')
    run('node', ['-r', 'sucrase/register', 'e2e/rigs/refinementsStartup.ts'], {
      TS_REFINEMENTS_ARTIFACTS: process.env.EVENT_INFO_ARTIFACTS,
      TS_REFINEMENTS_STARTUP_V8: temp
    })
  }
  if (phase !== 'server') {
    run('node', ['scripts/build-event-info-tests.mjs'])
    run(
      'node_modules/.bin/mocha',
      [
        '-r',
        'sucrase/register',
        '-r',
        './src/test/scoringDomSetup.cjs',
        '--timeout',
        '60000',
        'lib/event-info-tests.cjs'
      ],
      { NODE_V8_COVERAGE: temp }
    )
  }
}
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
if (process.env.EVENT_INFO_BROWSER_COVERAGE != null)
  map.merge(
    JSON.parse(readFileSync(process.env.EVENT_INFO_BROWSER_COVERAGE, 'utf8'))
  )
writeFileSync(
  resolve(report, 'coverage-final.json'),
  JSON.stringify(map.toJSON())
)
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
let diff = git(['diff', '--unified=0', base, '--', ...paths])
for (const path of untracked.filter(path => paths.includes(path))) {
  const source = readFileSync(path, 'utf8')
  const lines = source.trimEnd().split('\n')
  diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
}
const counts = {}
for (const path of paths)
  if (map.files().includes(resolve(path)))
    counts[path] = istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
const result = lineReportFromCounts(changedLines(diff), counts, path =>
  paths.includes(path)
)
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify(result, null, 2)
)
const failures = Object.entries(result.files).filter(([, lines]) => {
  const total = lines.covered.length + lines.uncovered.length
  return total > 0 && lines.covered.length / total < 0.9
})
console.log(
  `Event Info changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total} lines)`
)
if (failures.length > 0 || !result.pass || result.total === 0)
  throw new Error(
    `At least 90% changed runtime line coverage required: ${JSON.stringify(failures)}`
  )
