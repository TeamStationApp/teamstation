import { spawnSync } from 'node:child_process'
import {
  globSync,
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

import { webSettings } from './web-build-settings.mjs'

const report = resolve('coverage/creation')
const reportOnly = process.argv.includes('--report-only')
if (!reportOnly) rmSync(report, { recursive: true, force: true })
mkdirSync(report, { recursive: true })
const suites = [
  ...globSync('src/server/groups/**/*.test.ts'),
  ...globSync('src/server/notifications/*.test.ts'),
  ...globSync('src/server/socket/fanout.test.ts'),
  ...globSync('src/server/socket/gameSocket.test.ts'),
  ...globSync('src/server/admin/nodeAdministration.test.ts'),
  ...globSync('src/server/invites/personRequests.test.ts'),
  ...globSync('src/migrate/runner.test.ts'),
  ...globSync('src/server/schedule/**/*.test.ts'),
  ...globSync('src/server/routes/schedule.test.ts'),
  ...globSync('src/server/events/events.test.ts'),
  ...globSync('src/server/routes/events.test.ts'),
  ...globSync('src/server/access.test.ts'),
  ...globSync('src/server/routes/teams.test.ts'),
  ...globSync('src/server/routes/players.test.ts'),
  ...globSync('src/server/routes/users.test.ts'),
  ...globSync('src/server/teams/teamRoster.test.ts'),
  ...globSync('src/server/routes/seasons.test.ts'),
  ...globSync('src/server/scoreboard/scoreboardHub.test.ts'),
  ...globSync('src/server/jsonBody.test.ts'),
  ...globSync('src/server/routes/lineups.test.ts'),
  ...globSync('src/server/live/sync.test.ts'),
  ...globSync('src/server/live/splitter.test.ts'),
  ...globSync('src/server/live/finishStream.test.ts'),
  ...globSync('src/server/admin/mergeTeams.test.ts'),
  ...globSync('src/server/routes/manage.test.ts'),
  ...globSync('src/migrate/creationHierarchy.test.ts'),
  ...globSync('src/server/location/**/*.test.ts'),
  ...globSync('src/server/media/pictureCatalog.test.ts'),
  ...globSync('src/server/routes/pictures.test.ts'),
  ...globSync('src/server/routes/location.test.ts'),
  ...globSync('src/common/publicStaffName.test.ts'),
  ...globSync('src/common/seasonTimeFrames.test.ts'),
  ...globSync('src/common/gameTime.test.ts'),
  ...globSync('src/app/navigation/*.test.ts'),
  ...globSync('src/app/components/iconFont.test.ts'),
  ...globSync('src/app/platform/roughLocation*.test.ts'),
  ...globSync('src/server/teams/storeTeamPictures.test.ts'),
  ...globSync('src/server/openapi.test.ts'),
  ...globSync('src/server/auth/settleAccount.test.ts'),
  ...globSync('src/server/auth/codeDelivery.test.ts'),
  ...globSync('src/server/admin/people.test.ts'),
  ...globSync('src/server/routes/signup.test.ts'),
  ...globSync('src/server/routes/invites.test.ts'),
  ...globSync('src/server/auth/emailCodes.test.ts'),
  ...globSync('src/server/auth/signInLink.test.ts')
]
const paths = [...globSync('src/server/groups/**/*.ts')]
  .filter(file => !file.endsWith('.test.ts'))
  .concat([
    'src/server/db/atomic.ts',
    'src/common/nodeAdministration.ts',
    'src/server/admin/nodeAdministration.ts',
    'src/server/routes/nodeAdministration.ts',
    'src/server/invites/personRequests.ts',
    'src/app/hooks/useLatestRequest.ts',
    'src/app/screens/NodeAdministrationScreen.tsx',
    'src/common/seasonTimeFrames.ts',
    'src/common/gameTime.ts',
    'src/common/gameApprovals.ts',
    'src/server/schedule/gameApprovals.ts',
    'src/server/schedule/gameApprovalOpenApi.ts',
    'src/server/routes/gameApprovals.ts',
    'src/app/screens/GameFormScreen.tsx',
    'src/app/screens/gameDraft.ts',
    'src/app/screens/GroupGameSchedule.tsx',
    'src/app/hooks/useForegroundRefresh.ts',
    'src/app/screens/CreateGroupScreen.tsx',
    'src/app/screens/HomeScreen.tsx',
    'src/app/components/AppHeader.tsx',
    'src/app/components/SectionHeader.tsx',
    'src/app/screens/DiscoverScreen.tsx',
    'src/app/screens/GroupScreen.tsx',
    'src/app/screens/GroupLinkScreen.tsx',
    'src/app/screens/GroupSettingsScreen.tsx',
    'src/app/screens/NotificationsScreen.tsx',
    'src/app/screens/PromoteExternalScreen.tsx',
    'src/app/components/DateRangePicker.tsx',
    'src/app/components/GroupPictureChooser.tsx',
    'src/common/groupCreation.ts',
    'src/common/groupLinks.ts',
    'src/common/publicGroups.ts',
    'src/common/notifications.ts',
    'src/server/routes/groups.ts',
    'src/server/routes/notifications.ts',
    'src/server/notifications/inbox.ts',
    'src/server/notifications/requestInformation.ts',
    'src/common/pictureCatalog.ts',
    'src/common/onboarding.ts',
    'src/server/auth/settleAccount.ts',
    'src/server/auth/codeDelivery.ts',
    'src/server/routes/onboarding.ts',
    'src/app/screens/OnboardingScreen.tsx',
    'src/common/locality.ts',
    'src/common/publicStaffName.ts',
    'src/server/media/pictureCatalog.ts',
    'src/server/location/places.ts',
    'src/server/routes/pictures.ts',
    'src/server/routes/location.ts',
    'src/app/platform/roughLocation.ts',
    'src/app/platform/roughLocationNative.ts',
    'src/app/platform/getRoughLocation.ts',
    'src/app/components/PhotoGrid.tsx',
    'src/app/components/CreationCard.tsx',
    'src/app/components/LocalityPicker.tsx',
    'src/app/components/LeagueCityField.tsx'
  ])
const uiSuites = [
  'src/app/components/PhotoGrid.test.tsx',
  'src/app/components/LocalityPicker.test.tsx',
  'src/app/components/LeagueCityField.test.tsx',
  'src/app/platform/getRoughLocation.test.tsx',
  'src/app/components/VideoPoster.test.tsx',
  'src/app/screens/OnboardingScreen.test.tsx',
  'src/app/screens/groupCreation.test.tsx',
  'src/app/screens/creationUi.test.tsx',
  'src/app/screens/HomeScreen.test.tsx',
  'src/app/screens/HomeScreen.recentGame.test.tsx',
  'src/app/screens/gameCreation.test.tsx',
  'src/app/screens/GameFormScreen.create.test.tsx',
  'src/app/screens/gameDraft.test.ts',
  'src/app/screens/ManageScreen.test.tsx',
  'src/app/screens/AccountScreen.test.tsx',
  'src/app/screens/expandedStats.test.tsx',
  'src/app/components/RolesModal.test.tsx'
]
const temp = resolve(report, 'tmp')
mkdirSync(temp, { recursive: true })
mkdirSync('lib', { recursive: true })
if (!reportOnly)
  await build({
    ...webSettings,
    stdin: {
      contents: uiSuites.map(file => `import './${file}'`).join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'creation-test-entry.ts'
    },
    outfile: 'lib/creation-tests.cjs',
    platform: 'node',
    format: 'cjs',
    bundle: true,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'jsdom', 'mocha', 'chai'],
    sourcemap: true,
    define: {
      __DEV__: 'true',
      TS_API_BASE_URL: JSON.stringify('/api/v1'),
      'process.env.NODE_ENV': JSON.stringify('test')
    },
    loader: { '.png': 'dataurl', '.svg': 'dataurl' }
  })
if (paths.length === 0 || suites.length === 0)
  throw new Error('No creation runtime paths or tests')
function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, NODE_V8_COVERAGE: temp }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (!reportOnly) {
  run('node', ['src/migrate/requirePostgres18.js'])
  run('node_modules/.bin/mocha', [
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    '--timeout',
    '60000',
    ...suites,
    'lib/creation-tests.cjs'
  ])
  if (process.env.TS_CREATION_ARTIFACTS == null)
    throw new Error('Set TS_CREATION_ARTIFACTS for browser creation coverage')
  run('node', ['src/build.mjs'])
  run('node', [
    '-r',
    'sucrase/register',
    'src/app/creation.e2e.ts',
    '--phase',
    'M3'
  ])
  run('node', ['-r', 'sucrase/register', 'src/app/groupCreation.e2e.ts'])
  run('node', ['-r', 'sucrase/register', 'src/app/gameCreation.e2e.ts'])
  run('node', ['-r', 'sucrase/register', 'src/app/memberAdministration.e2e.ts'])
  run('node', ['-r', 'sucrase/register', 'src/app/relationshipCorners.e2e.ts'])
  run('node', ['-r', 'sucrase/register', 'src/app/reviewCreation.e2e.ts'])
  run('node', ['-r', 'sucrase/register', 'src/app/creationUi.e2e.ts'])
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
  '--reporter=json-summary',
  '--reports-dir',
  report,
  '--exclude-after-remap',
  ...paths
    .concat([
      'src/common/api.ts',
      'src/server/access.ts',
      'src/server/schedule/scheduleGames.ts',
      'src/server/routes/schedule.ts',
      'src/server/events/postPlays.ts',
      'src/server/admin/mergeTeams.ts',
      'src/server/admin/people.ts',
      'src/server/socket/fanout.ts',
      'src/server/socket/gameSocket.ts',
      'src/server/invites/people.ts',
      'src/server/routes/manage.ts',
      'src/server/routes/seasons.ts',
      'src/server/teams/storeTeamPictures.ts',
      'src/server/teams/createTeam.ts',
      'src/server/teams/teamRoster.ts',
      'src/server/routes/teams.ts',
      'src/server/routes/stats.ts',
      'src/server/stats/rows.ts',
      'src/server/scoreboard/scoreboardHub.ts',
      'src/server/jsonBody.ts',
      'src/server/routes/lineups.ts',
      'src/server/live/controller.ts',
      'src/server/live/splitter.ts',
      'src/server/openapi.ts',
      'src/app/components/VideoPoster.tsx',
      'src/app/App.tsx',
      'src/app/screens/ManageScreen.tsx',
      'src/app/screens/AccountScreen.tsx',
      'src/app/screens/TeamScreen.tsx',
      'src/app/screens/JoinScreen.tsx',
      'src/app/screens/HomeScreen.tsx',
      'src/app/components/AppHeader.tsx',
      'src/app/navigation/routes.ts',
      'src/app/assets/index.ts',
      'src/app/screens/LoginScreen.tsx',
      'src/server/routes/auth.ts',
      'src/server/auth/sessions.ts',
      'src/server/auth/emailCodes.ts',
      'src/server/invites/invites.ts',
      'src/server/invites/joining.ts'
    ])
    .flatMap(file => ['--include', file]),
  '--exclude',
  '**/*.test.*',
  '--exclude',
  'src/test/**'
])
const merger = createRequire(import.meta.url)('istanbul-lib-coverage')
const map = merger.createCoverageMap(
  JSON.parse(readFileSync(resolve(report, 'coverage-final.json'), 'utf8'))
)
map.merge(JSON.parse(readFileSync(resolve(report, 'browser.json'), 'utf8')))
map.merge(
  JSON.parse(readFileSync(resolve(report, 'groups-browser.json'), 'utf8'))
)
map.merge(
  JSON.parse(readFileSync(resolve(report, 'games-browser.json'), 'utf8'))
)
map.merge(
  JSON.parse(readFileSync(resolve(report, 'members-browser.json'), 'utf8'))
)
map.merge(
  JSON.parse(readFileSync(resolve(report, 'corners-browser.json'), 'utf8'))
)
map.merge(
  JSON.parse(readFileSync(resolve(report, 'review-browser.json'), 'utf8'))
)
map.merge(JSON.parse(readFileSync(resolve(report, 'ui-browser.json'), 'utf8')))
writeFileSync(
  resolve(report, 'coverage-final.json'),
  JSON.stringify(map.toJSON())
)
const mergedSummary = {}
for (const file of map.files())
  mergedSummary[file] = map.fileCoverageFor(file).toSummary().toJSON()
writeFileSync(
  resolve(report, 'coverage-summary.json'),
  JSON.stringify(mergedSummary)
)
const summary = JSON.parse(
  readFileSync(resolve(report, 'coverage-summary.json'), 'utf8')
)
for (const file of paths) {
  const count = summary[resolve(file)]?.lines
  if (count == null || count.total === 0 || count.pct < 90)
    throw new Error(
      `${file}: expected mapped line coverage >=90%, got ${JSON.stringify(count)}`
    )
}

const totals = paths.map(file => summary[resolve(file)].lines)
const total = totals.reduce((sum, row) => sum + row.total, 0)
const covered = totals.reduce((sum, row) => sum + row.covered, 0)
console.log(
  `Creation runtime mapped coverage: ${((100 * covered) / total).toFixed(2)}% (${covered}/${total} lines)`
)

const require = createRequire(import.meta.url)
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
const changedRuntime = [
  ...paths,
  'src/app/screens/HomeScreen.tsx',
  'src/app/components/AppHeader.tsx',
  'src/app/navigation/routes.ts',
  'src/app/assets/index.ts',
  'src/server/routes/seasons.ts',
  'src/server/admin/mergeTeams.ts',
  'src/server/access.ts',
  'src/server/schedule/scheduleGames.ts',
  'src/server/routes/schedule.ts',
  'src/server/events/postPlays.ts',
  'src/server/invites/people.ts',
  'src/server/routes/manage.ts',
  'src/server/socket/fanout.ts',
  'src/server/socket/gameSocket.ts',
  'src/common/api.ts',
  'src/server/teams/storeTeamPictures.ts',
  'src/server/teams/createTeam.ts',
  'src/server/teams/teamRoster.ts',
  'src/server/routes/teams.ts',
  'src/server/routes/stats.ts',
  'src/server/stats/rows.ts',
  'src/server/scoreboard/scoreboardHub.ts',
  'src/server/jsonBody.ts',
  'src/server/routes/lineups.ts',
  'src/server/live/controller.ts',
  'src/server/live/splitter.ts',
  'src/server/openapi.ts',
  'src/app/components/VideoPoster.tsx',
  'src/app/App.tsx',
  'src/app/screens/ManageScreen.tsx',
  'src/app/screens/AccountScreen.tsx',
  'src/app/screens/TeamScreen.tsx',
  'src/app/screens/JoinScreen.tsx',
  'src/app/screens/LoginScreen.tsx',
  'src/server/routes/auth.ts',
  'src/server/auth/sessions.ts',
  'src/server/auth/emailCodes.ts',
  'src/server/invites/invites.ts',
  'src/server/invites/joining.ts'
]
const base = spawnSync(
  'git',
  ['merge-base', process.env.TS_COVERAGE_BASE ?? 'origin/master', 'HEAD'],
  { encoding: 'utf8' }
)
if (base.status !== 0)
  throw new Error('Could not resolve creation coverage base')
const diff = spawnSync(
  'git',
  ['diff', '--unified=0', base.stdout.trim(), '--', ...changedRuntime],
  { encoding: 'utf8' }
)
if (diff.status !== 0) throw new Error('Could not derive changed runtime lines')
const changes = changedLines(diff.stdout)
const data = JSON.parse(
  readFileSync(resolve(report, 'coverage-final.json'), 'utf8')
)
const counts = {}
for (const file of changedRuntime)
  if (data[resolve(file)] != null)
    counts[file] = istanbulCounts(data[resolve(file)])
const changed = lineReportFromCounts(changes, counts, file =>
  changedRuntime.includes(file)
)
if (changed.total === 0 || !changed.pass)
  throw new Error(
    `Creation changed-line gate failed: ${JSON.stringify(changed)}`
  )
console.log(
  `Creation changed runtime coverage: ${changed.percent.toFixed(2)}% (${changed.covered}/${changed.total} lines)`
)
