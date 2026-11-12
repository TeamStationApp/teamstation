import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { build } from 'esbuild'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

// Line coverage of what naming a person in full to a reader who may read it
// adds and changes, from the suites that exercise it. The gate reads the diff
// from `TS_COVERAGE_BASE` (origin/develop unless given) to HEAD, so it runs
// after the commit, and asks 90% of each changed file's executable lines.
const base = process.env.TS_COVERAGE_BASE ?? 'origin/develop'
const specs = [
  'src/server/users/readerNames.integration.test.ts',
  'src/server/groups/playerNamePrivacy.test.ts',
  'src/server/groups/playerNamePrivacyReads.test.ts',
  'src/server/users/nameBook.test.ts',
  'src/server/teams/teamRoster.test.ts',
  'src/server/routes/people.test.ts',
  'src/server/routes/players.test.ts',
  'src/server/routes/teams.test.ts',
  'src/server/routes/stats.test.ts',
  'src/server/graphql/graphql.test.ts',
  'src/server/events/eventInfo.test.ts',
  'src/server/routes/chat.test.ts',
  'src/server/routes/chatBlocks.test.ts',
  'src/server/routes/chatMessages.test.ts',
  'src/server/notifications/inbox.test.ts',
  'src/server/notifications/requestInformation.test.ts',
  'src/server/groups/guardianRequests.test.ts',
  'src/server/groups/noticePolicy.test.ts',
  'src/server/teams/addExistingPlayer.test.ts',
  'src/server/umpires/savePeople.test.ts',
  'src/server/umpires/leaderboardPages.test.ts',
  'src/server/umpires/umpireNames.integration.test.ts',
  'src/server/umpires/schedule.test.ts',
  'src/server/routes/users.test.ts',
  'src/server/routes/videoCollections.test.ts',
  'src/server/users/rosterCandidates.test.ts',
  'src/server/umpires/admin.test.ts',
  'src/server/routes/events.test.ts',
  'src/server/scoring/gameStatistics.integration.test.ts',
  'src/server/routes/lineups.test.ts',
  'src/server/routes/publicGameAccess.test.ts',
  'src/server/routes/highlightRoutes.test.ts',
  'src/server/users/derivedNames.test.ts',
  'src/common/api.test.ts',
  'src/common/scoring/readerNames.test.ts',
  'src/common/scoring/storedNames.test.ts',
  'src/common/scoring/actions.test.ts',
  'src/common/scoring/rosterCommands.test.ts',
  'src/common/replay/replayNames.test.ts',
  'src/app/sync/outbox.test.ts',
  'src/app/sync/cacheStore.test.ts',
  'src/app/scoring/scoringMotion.test.ts',
  'src/app/scoring/scoringRosterCache.test.ts',
  'src/app/scoring/currentSetup.test.ts',
  'src/app/scoring/playerDraft.test.ts',
  'src/app/scoring/lineupQrImport.test.ts',
  'src/app/scoring/lineupQrExport.test.ts',
  'src/app/scoring/fieldAdapter.test.ts',
  'src/app/scoring/playerNameFormat.test.ts',
  'src/common/scoring/startingSetup.test.ts',
  'src/app/scoring/createDictatedPlayers.test.ts',
  'src/app/chat/chat2Mentions.test.ts'
]
// `.tsx` specs run from one bundle, with the web's `react-native`.
const screens = [
  'src/app/screens/PlayerScreen.test.tsx',
  'src/app/scoring/scoringScreenField.test.tsx',
  'src/app/scoring/RosterEditor.coach.test.tsx',
  'src/app/replay/GameReplayScreen.test.tsx',
  'src/app/App.scoringRosterEdit.test.tsx'
]

const database = spawnSync('node', ['src/migrate/requirePostgres18.js'], {
  stdio: 'inherit'
})
if (database.status !== 0) process.exit(1)
const report = resolve('coverage/fullName')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

const bundle = 'lib/full-name-tests.cjs'
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
      sourcefile: 'full-name-tests.ts'
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
    loader: ASSET_LOADER
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
  resolve(report, 'changed-90.json'),
  '--min',
  '90',
  '--ext',
  '.ts',
  '--ext',
  '.tsx',
  '--exclude',
  'src/test',
  'src/server',
  'src/common',
  'src/app'
])
process.exit(tests || coverage || gate)
