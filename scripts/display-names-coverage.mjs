import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { build } from 'esbuild'

import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

// Line coverage of what the display names and images work adds and changes
// (the plan's milestones each append their suites), from the suites that
// exercise it. The gate reads the diff from `TS_COVERAGE_BASE` (origin/develop
// unless given) to HEAD, so it runs after the commit, and asks 95% of each
// changed file's executable lines under src/server, src/common and src/app,
// tests, fixtures and end-to-end files left out: the combined unit and
// integration gate AGENTS.md sets.
const base = process.env.TS_COVERAGE_BASE ?? 'origin/develop'
const specs = [
  // M1: who may see a full name (`mayViewFullNames`) and its callers.
  'src/server/access.integration.test.ts',
  'src/server/users/readerNames.integration.test.ts',
  'src/server/groups/playerNamePrivacyReads.integration.test.ts',
  'src/server/groups/noticePolicy.integration.test.ts',
  'src/server/routes/players.integration.test.ts',
  'src/server/routes/people.integration.test.ts',
  'src/server/routes/guardians.integration.test.ts',
  'src/server/users/peopleCandidates.integration.test.ts',
  'src/server/teams/teamRoster.integration.test.ts',
  'src/server/events/eventInfo.integration.test.ts',
  'src/server/routes/chat.integration.test.ts',
  'src/server/users/nameBook.integration.test.ts',
  'src/server/teams/onPeopleList.unit.test.ts',
  'src/server/teams/headCoachViews.unit.test.ts',
  // M2: every name in its format alone (`formatNames`, `shortNames`).
  'src/common/names.test.ts',
  'src/common/replay/replayNames.test.ts',
  'src/common/replay/replayBoxScore.test.ts',
  'src/common/replay/narration.test.ts',
  'src/server/scoring/openRow.integration.test.ts',
  'src/server/routes/follows.integration.test.ts',
  'src/server/groups/playerNamePrivacy.integration.test.ts',
  'src/server/umpires/leaderboardPages.integration.test.ts',
  'src/server/users/rosterCandidates.integration.test.ts',
  'src/server/dev/userIdGuestComparison.integration.test.ts',
  'src/app/scoring/currentSetup.test.ts',
  'src/app/scoring/lineupQrImport.test.ts',
  'src/app/scoring/playerDraft.test.ts',
  'src/app/scoring/playerNameFormat.test.ts',
  'src/app/sync/outbox.test.ts',
  // M3: one affiliation line on every person list (`personAffiliations`).
  'src/server/users/personAffiliations.integration.test.ts',
  'src/server/routes/nonMemberView.integration.test.ts',
  'src/server/teams/addExistingPlayer.integration.test.ts',
  'src/server/umpires/admin.integration.test.ts',
  'src/server/games/guestPlayers.integration.test.ts',
  'src/server/games/poolVisibility.integration.test.ts',
  'src/server/umpires/savePeople.integration.test.ts',
  'src/server/openapi.test.ts',
  'src/common/api.test.ts',
  'src/common/umpireCleaners.test.ts',
  // M5: team, league and season colours, and a season in its league's picture.
  'src/app/components/teamTile.test.ts',
  'src/app/components/teamEmblemUsage.test.ts',
  'src/app/chat/chat2Identity.test.ts',
  'src/server/chat/chat2Identity.integration.test.ts',
  'src/server/routes/seasons.integration.test.ts',
  'src/server/groups/publicSummary.integration.test.ts',
  'src/server/home/homeLists.integration.test.ts',
  'src/server/routes/live.integration.test.ts',
  // M6: person colours (`personTint`, by account id alone) and `PersonEmblem`.
  'src/app/components/emblemUsage.test.ts',
  'src/app/chat/engine/dmTitle.test.ts',
  'src/common/eventInfo.test.ts',
  'src/server/routes/chatBlocks.integration.test.ts',
  'src/server/routes/manage.integration.test.ts',
  'src/server/routes/users.integration.test.ts',
  'src/server/routes/teamMembers.integration.test.ts',
  'src/server/routes/phoneStreams.integration.test.ts',
  'src/server/admin/nodeAdministration.integration.test.ts',
  'src/server/umpires/assignments.integration.test.ts',
  'src/server/games/rosterAvailability.integration.test.ts',
  'src/server/groups/legacyAuthority.integration.test.ts',
  'src/server/routes/account.integration.test.ts',
  'src/server/routes/signup.integration.test.ts',
  'src/server/routes/tvLogin.integration.test.ts',
  'src/app/platform/sessionStore.test.ts'
]
// `.tsx` specs run from one bundle, with the web's `react-native`.
const screens = [
  // M2
  'src/app/screens/PlayerScreen.test.tsx',
  // M4: the affiliation line under every person a list names.
  'src/app/components/PersonAffiliationLine.test.tsx',
  'src/app/components/PersonSearchRow.test.tsx',
  'src/app/components/relationshipLists.test.tsx',
  'src/app/screens/teamRoster.test.tsx',
  'src/app/screens/SeasonPage.test.tsx',
  'src/app/screens/AddPlayerScene.test.tsx',
  'src/app/scoring/ExistingPlayerSheet.test.tsx',
  'src/app/chat/chatUi.test.tsx',
  'src/app/chat/chat2Info.test.tsx',
  'src/app/umpires/management.test.tsx',
  'src/app/hooks/useRosterCandidates.test.tsx',
  // M5
  'src/app/components/GroupEmblem.test.tsx',
  'src/app/components/settingsCleanup3Pieces.test.tsx',
  'src/app/components/GameHeroCard.test.tsx',
  'src/app/components/ChildCard.test.tsx',
  'src/app/components/settingsPieces.test.tsx',
  'src/app/chat/chat2IdentityView.test.tsx',
  'src/app/screens/HomeScreen.test.tsx',
  'src/app/screens/SeasonScreen.test.tsx',
  'src/app/screens/groupCreation.test.tsx',
  'src/app/screens/creationUi.test.tsx',
  'src/app/umpires/appMask.test.tsx',
  'src/app/screens/FollowTeamScreen.test.tsx',
  'src/app/components/cardSpacingFixture.test.tsx',
  // M6
  'src/app/components/PersonEmblem.test.tsx',
  'src/app/components/AppHeader.test.tsx',
  'src/app/screens/NodeAdministrationScreen.test.tsx',
  'src/app/screens/PersonProfileScreen.test.tsx',
  'src/app/screens/EventInfoTab.test.tsx',
  'src/app/screens/EventRsvpModal.test.tsx',
  'src/app/screens/ScheduleRsvpControl.test.tsx',
  'src/app/screens/teamSchedule.test.tsx',
  'src/app/screens/peopleAccounts.test.tsx',
  'src/app/screens/settingsPeople.test.tsx',
  'src/app/stream/CameraAnglesPanel.test.tsx',
  'src/app/umpires/scheduleUi.test.tsx',
  'src/app/chat/chatBlocksView.test.tsx'
]

const database = spawnSync('node', ['src/migrate/requirePostgres18.js'], {
  stdio: 'inherit'
})
if (database.status !== 0) process.exit(1)
const report = resolve('coverage/displayNames')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

const bundle = 'lib/display-names-tests.cjs'
if (screens.length > 0)
  await build({
    ...webSettings,
    // Paged lists render as the app suites render them (build-scoring-tests).
    plugins: [...webSettings.plugins, pagedListStandInPlugin()],
    alias: {
      ...webSettings.alias,
      'react-native-webview': './src/test/eventWebViewStub.tsx',
      'react-native-maps': './src/test/eventNativeMapStub.tsx'
    },
    stdin: {
      contents: screens.map(file => `import './${file}'`).join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'display-names-tests.ts'
    },
    outfile: bundle,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'jsdom', 'mocha', 'chai'],
    sourcemap: true,
    define: {
      ...webSettings.define,
      __DEV__: 'true',
      TS_API_BASE_URL: JSON.stringify('/api/v1'),
      'process.env.NODE_ENV': JSON.stringify('test')
    },
    loader: { '.png': 'dataurl', '.svg': 'dataurl' }
  })

const run = (command, args, env = process.env) => {
  console.log('$', command, ...args)
  return spawnSync(command, args, { stdio: 'inherit', env }).status ?? 1
}

const tests = run(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    '--timeout',
    '60000',
    '--extension',
    'ts',
    '--reporter',
    'dot',
    '--exit',
    ...specs.flatMap(spec => ['--spec', spec]),
    ...(screens.length > 0 ? ['--spec', bundle] : [])
  ],
  { ...process.env, NODE_V8_COVERAGE: temp }
)
const coverage = run('node_modules/.bin/c8', [
  'report',
  '--reporter=text',
  '--reporter=json',
  '--reports-dir',
  report,
  '--temp-directory',
  temp,
  '--include',
  'src/**/*.ts',
  '--include',
  'src/**/*.tsx',
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude',
  'src/test/**',
  '--exclude-after-remap'
])
const gate = run('node', [
  'scripts/changed-line-check.cjs',
  '--base',
  base,
  '--coverage',
  resolve(report, 'coverage-final.json'),
  '--report',
  resolve(report, 'changed-95.json'),
  '--min',
  '95',
  '--ext',
  '.ts',
  '--ext',
  '.tsx',
  '--exclude',
  'src/test',
  '--exclude',
  '**/*.fixture.*',
  'src/server',
  'src/common',
  'src/app'
])
process.exit(tests || coverage || gate)
