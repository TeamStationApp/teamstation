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

import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
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
  ...globSync('src/server/events/eventInfo.test.ts'),
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
  ...globSync('src/server/routes/cityLookup.test.ts'),
  ...globSync('src/server/routes/googleEventLookup.test.ts'),
  ...globSync('src/app/components/googleMapDocument.test.ts'),
  ...globSync('src/common/publicStaffName.test.ts'),
  ...globSync('src/common/seasonTimeFrames.test.ts'),
  ...globSync('src/common/gameTime.test.ts'),
  ...globSync('src/app/navigation/*.test.ts'),
  ...globSync('src/app/components/iconFont.test.ts'),
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
    'src/app/screens/LocationScreen.tsx',
    'src/app/screens/GroupLocationPage.tsx',
    'src/app/components/LocationRow.tsx',
    'src/app/components/TextField.tsx',
    'src/app/components/AddEventCard.tsx',
    'src/app/screens/TeamPage.tsx',
    'src/app/screens/TeamSelectorScene.tsx',
    'src/server/location/googlePlaces.ts',
    'src/server/location/coordinateTimezone.ts',
    'src/server/location/googleLookupLimits.ts',
    'src/server/location/eventGeocoder.ts',
    'src/server/routes/eventInfo.ts',
    'src/common/eventPlaces.ts',
    'src/app/components/EventVenueFields.tsx',
    'src/app/components/googleMapDocument.ts',
    'src/app/components/EventMap.tsx',
    'src/app/components/EventMap.native.tsx',
    'src/app/components/EventMap.android.tsx',
    'src/app/components/Button.tsx',
    'src/app/components/Badge.tsx',
    'src/app/components/PillTabs.tsx',
    'src/app/theme/pill.ts',
    'src/app/screens/DiscoverScreen.tsx',
    'src/app/screens/GroupScreen.tsx',
    'src/app/screens/GroupLinkScreen.tsx',
    'src/app/screens/GroupSettingsScreen.tsx',
    'src/app/screens/ManagementCard.tsx',
    'src/app/screens/AddPeopleScreen.tsx',
    'src/app/screens/GroupPeoplePage.tsx',
    'src/app/components/RoleSwitches.tsx',
    'src/app/components/ChoiceSheet.tsx',
    'src/app/components/RolesModal.tsx',
    'src/app/locales/en_US.ts',
    'src/app/components/roleLabels.ts',
    'src/common/emailList.ts',
    'src/app/screens/InviteSpectatorsScreen.tsx',
    'src/app/screens/InvitationsWaiting.tsx',
    'src/app/screens/ManagePlayers.tsx',
    'src/app/screens/ParentOrganizations.tsx',
    'src/app/components/BreakParentSheet.tsx',
    'src/app/screens/useBreakParent.tsx',
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
    'src/app/components/PhotoGrid.tsx',
    'src/app/components/CreationCard.tsx'
  ])
const uiSuites = [
  'src/app/components/EventVenueFields.test.tsx',
  'src/app/components/EventMap.native.test.tsx',
  'src/app/components/EventMap.android.test.tsx',
  'src/app/screens/LocationScreen.test.tsx',
  'src/app/screens/TeamPage.test.tsx',
  'src/app/screens/TeamSelectorScene.test.tsx',
  'src/app/screens/NotificationsScreen.test.tsx',
  'src/app/screens/GroupSettingsScreen.test.tsx',
  'src/app/screens/settingsPeople.test.tsx',
  'src/app/components/settingsPieces.test.tsx',
  'src/app/components/pillGeometry.test.tsx',
  'src/app/components/PillTabs.test.tsx',
  'src/app/components/PhotoGrid.test.tsx',
  'src/app/components/VideoPoster.test.tsx',
  'src/app/screens/OnboardingScreen.test.tsx',
  'src/app/screens/groupCreation.test.tsx',
  'src/app/screens/creationUi.test.tsx',
  'src/app/screens/HomeScreen.test.tsx',
  'src/app/screens/HomeScreen.recentGame.test.tsx',
  'src/app/screens/gameCreation.test.tsx',
  'src/app/screens/GameFormScreen.create.test.tsx',
  'src/app/screens/gameDraft.test.ts',
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
    plugins: [...webSettings.plugins, pagedListStandInPlugin()],
    alias: {
      ...webSettings.alias,
      'react-native-webview': './src/test/eventWebViewStub.tsx',
      'react-native-maps': './src/test/eventNativeMapStub.tsx'
    },
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
  for (const scenario of ['E2', 'E4', 'E8', 'E11', 'E14'])
    run('node', [
      '-r',
      'sucrase/register',
      'src/app/settingsCleanup.e2e.ts',
      '--only',
      scenario
    ])
  run('node', ['-r', 'sucrase/register', 'src/app/settingsPillSweep.e2e.ts'])
  run('node', [
    '-r',
    'sucrase/register',
    'src/app/googleProviderConsistency.e2e.ts'
  ])
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
      'src/app/components/iconCodepoints.ts',
      'src/app/screens/PlaceholderTeamForm.tsx',
      'src/server/schedule/pendingProjection.ts',
      'src/common/errors.ts',
      'src/server/serverConfig.ts',
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
for (const file of [
  'settings-E2-browser.json',
  'settings-E4-browser.json',
  'settings-E8-browser.json',
  'settings-E11-browser.json',
  'settings-E14-browser.json',
  'settings-sweep-browser.json',
  'google-provider-browser.json'
])
  map.merge(JSON.parse(readFileSync(resolve(report, file), 'utf8')))

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
  'src/app/components/iconCodepoints.ts',
  'src/app/screens/PlaceholderTeamForm.tsx',
  'src/server/schedule/pendingProjection.ts',
  'src/common/errors.ts',
  'src/server/serverConfig.ts',
  'src/app/screens/TeamScreen.tsx',
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
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify(changed, null, 2)
)
const changedFailures = Object.entries(changed.files).filter(([, lines]) => {
  const total = lines.covered.length + lines.uncovered.length
  return total > 0 && lines.covered.length / total < 0.9
})
if (changed.total === 0 || !changed.pass || changedFailures.length > 0)
  throw new Error(
    `Creation changed-line gate failed: ${JSON.stringify({ ...changed, perFileFailures: changedFailures.map(([file]) => file) })}`
  )
console.log(
  `Creation changed runtime coverage: ${changed.percent.toFixed(2)}% (${changed.covered}/${changed.total} lines)`
)
