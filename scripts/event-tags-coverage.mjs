import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { fileURLToPath } from 'node:url'

const paths = [
  'src/common/eventTags.ts',
  'src/common/scoring/session.ts',
  'src/common/scoring/comparable.ts',
  'src/common/api.ts',
  'src/server/events/eventTags.ts',
  'src/server/events/eventWrite.ts',
  'src/server/events/postPlays.ts',
  'src/server/routes/events.ts',
  'src/server/routes/players.ts',
  'src/server/highlights.ts',
  'src/server/openapi.ts',
  'src/app/scoring/localEventTags.ts',
  'src/app/scoring/scoringSource.ts',
  'src/app/scoring/playDescription.ts',
  'src/app/scoring/useHoldSelection.ts',
  'src/app/scoring/EventTagEditor.tsx',
  'src/app/scoring/ScoringHistory.tsx',
  'src/app/field/BaseballScreen.tsx',
  'src/app/scoring/ScoringScreen.tsx',
  'src/app/screens/GameScreen.tsx',
  'src/app/components/EventTagText.tsx'
]
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run('node', ['scripts/build-scoring-tests.mjs'])
const temp = 'coverage/tags-tmp'
rmSync(temp, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
const testEnv = { env: { ...process.env, NODE_V8_COVERAGE: temp } }
// Migration CLI and server use different int8 parser contexts; isolate them.
run(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    'src/migrate/runner.test.ts',
    'src/migrate/upgrade.test.ts',
    'src/migrate/migrations/049expandedStats.test.ts'
  ],
  testEnv
)
run(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    'src/common/eventTags.test.ts',
    'src/common/api.test.ts',
    'src/common/scoring/session.test.ts',
    'src/app/scoring/localEventTags.test.ts',
    'src/app/scoring/scoringSource.test.ts',
    'src/app/scoring/playDescription.test.ts',
    'src/server/routes/events.test.ts',
    'src/server/highlights.test.ts',
    'src/server/routes/highlightRoutes.test.ts',
    'src/server/dev/refoldScoredGames.test.ts',
    'src/server/routes/lineups.test.ts',
    'src/server/scoreboard/gameSource.test.ts',
    'src/server/socket/gameSocket.test.ts',
    'src/server/openapi.test.ts'
  ],
  testEnv
)
run(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    'lib/scoring-tests.cjs',
    '--grep',
    'event tag UI|scoring UI updates|scoring screen field wiring|local scoring controls|saving from the scoring screen|scoring slide-up sheets|scoring shell and exit|actual game scoring entry|scoring entry on the phones|game actions preserve box score and videos|the game page.s card|the box score|a DJ Game row|the DJ Game button|the Score Game pill|the app, the Score Game screen and the dashboard'
  ],
  testEnv
)

for (const name of readdirSync(temp)) {
  const file = `${temp}/${name}`
  const coverage = JSON.parse(readFileSync(file, 'utf8'))
  for (const map of Object.values(coverage['source-map-cache'] ?? {}))
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  writeFileSync(file, JSON.stringify(coverage))
}
run('node_modules/.bin/c8', [
  'report',
  '--temp-directory',
  temp,
  '--report-dir',
  'coverage/tags',
  '--reporter=text',
  '--reporter=json',
  '--all',
  ...paths.flatMap(path => ['--include', path]),
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.integration.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude-after-remap'
])
run('node', [
  'scripts/changed-line-check.cjs',
  '--coverage',
  'coverage/tags/coverage-final.json',
  '--ext',
  '.ts',
  '--ext',
  '.tsx',
  ...paths
])
