import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { build } from 'esbuild'

import { webSettings } from './web-build-settings.mjs'

// Line coverage of what player name privacy adds and changes, from the suites
// that exercise it. The gate reads `git diff origin/master...HEAD`, so it runs
// after the commit.
const specs = [
  'src/common/names.test.ts',
  'src/common/playerNamePrivacy.test.ts',
  'src/migrate/migrations/098playerNamePrivacy.test.ts',
  'src/migrate/upgrade.test.ts',
  'src/server/groups/playerNamePrivacy.test.ts',
  'src/server/groups/publicSummary.test.ts',
  'src/server/groups/directActions.test.ts',
  'src/server/groups/clientContract.test.ts',
  'src/server/openapi.test.ts',
  'src/app/scoring/playerNameFormat.test.ts',
  'src/app/scoring/lineupQrImport.test.ts',
  'src/app/scoring/playerDraft.test.ts',
  'src/common/api.test.ts',
  'src/common/scoring/startingSetup.test.ts',
  'src/server/routes/lineups.test.ts',
  'src/server/routes/stats.test.ts',
  'src/server/routes/teams.test.ts',
  'src/server/routes/players.test.ts',
  'src/server/routes/users.test.ts',
  'src/server/routes/people.test.ts',
  'src/server/routes/chat.test.ts',
  'src/server/events/eventInfo.test.ts',
  'src/server/groups/guardianRequests.test.ts',
  'src/server/teams/teamRoster.test.ts',
  'src/server/groups/noticePolicy.test.ts',
  'src/server/games/poolVisibility.test.ts',
  'src/server/routes/seasonReaders.test.ts',
  'src/server/graphql/graphql.test.ts',
  'src/server/routes/rosterManagement.test.ts',
  'src/app/scoring/currentSetup.test.ts',
  'src/app/scoring/scoringMachine.test.ts',
  'src/app/scoring/dictatedRoster.test.ts',
  'src/app/sync/outbox.test.ts',
  'src/common/scoring/actions.test.ts',
  'src/common/scoring/rosterCommands.test.ts',
  'src/common/scoring/storedNames.test.ts',
  'src/server/groups/playerNamePrivacyReads.test.ts',
  'src/server/routes/events.test.ts',
  'src/server/scoreboard/boardTimeline.test.ts',
  'src/server/scoreboard/gameSource.test.ts',
  'src/server/socket/gameSocket.test.ts',
  'src/server/users/nameBook.test.ts'
]
const database = spawnSync('node', ['src/migrate/requirePostgres18.js'], {
  stdio: 'inherit'
})
if (database.status !== 0) process.exit(1)
// `.tsx` specs run from one bundle, with the web's `react-native`.
const screens = [
  'src/app/screens/PlayerNamePrivacyRow.test.tsx',
  'src/app/screens/GroupSettingsScreen.test.tsx',
  'src/app/screens/fullName.test.tsx',
  'src/app/screens/PlayerScreen.test.tsx'
]
const report = resolve('coverage/playerNamePrivacy')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

await build({
  ...webSettings,
  alias: {
    ...webSettings.alias,
    'react-native-webview': './src/test/eventWebViewStub.tsx',
    'react-native-maps': './src/test/eventNativeMapStub.tsx'
  },
  stdin: {
    contents: screens.map(file => `import './${file}'`).join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'player-name-privacy-tests.ts'
  },
  outfile: 'lib/player-name-privacy-tests.cjs',
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

const run = (command, args, env = process.env) =>
  spawnSync(command, args, { stdio: 'inherit', env }).status ?? 1

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
    '--spec',
    'lib/player-name-privacy-tests.cjs'
  ],
  { ...process.env, NODE_V8_COVERAGE: temp }
)
const coverage = run('node_modules/.bin/c8', [
  'report',
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
  '**/*.test.ts',
  '--exclude',
  '**/*.test.tsx',
  '--exclude-after-remap'
])
const gate = run('node', [
  'scripts/changed-line-check.cjs',
  '--coverage',
  'coverage/playerNamePrivacy/coverage-final.json',
  '--ext',
  '.ts',
  '--ext',
  '.tsx',
  '--exclude',
  'src/server/index.ts',
  '--exclude',
  'src/server/statsBuilder/start.ts',
  'src/common',
  'src/server',
  'src/app',
  'src/migrate'
])
process.exit(tests || coverage || gate)
