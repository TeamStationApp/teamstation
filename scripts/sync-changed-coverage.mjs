import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Changed-line coverage of the offline sync work: screen scopes on the
// socket, the sync clock, and the phone's cache and outbox. One mocha process
// runs the suites those changes can reach, server and app together, under
// NODE_V8_COVERAGE. The gate reads `git merge-base origin/master HEAD` to
// HEAD, so it runs after the milestone is committed.
const temp = resolve('coverage/sync/tmp')
rmSync(resolve('coverage/sync'), { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

const SPECS = [
  'src/common/gameSocket.test.ts',
  'src/server/socket/gameSocket.test.ts',
  'src/server/socket/fanout.test.ts',
  'src/server/schedule/gameScopeSocket.test.ts',
  'src/server/routes/events.test.ts',
  'src/server/routes/lineups.test.ts',
  'src/server/routes/rosterCreation.test.ts',
  'src/server/routes/players.test.ts',
  'src/server/routes/live.test.ts',
  'src/server/live/finishStream.test.ts',
  'src/server/live/reconnectGrace.test.ts',
  'src/server/live/sync.test.ts',
  'src/server/live/syncOnce.test.ts',
  'src/server/live/wallAnchors.test.ts',
  'src/server/routes/phoneStreams.test.ts',
  'src/server/groups/liveAuthority.test.ts',
  'src/server/groups/liveRevocationRecording.test.ts',
  'src/server/director/purge.test.ts',
  'src/common/api.test.ts',
  'src/server/routes/schedule.test.ts',
  'src/server/schedule/scheduleGames.test.ts',
  'src/server/schedule/gameRefinements.test.ts',
  'src/server/schedule/batchApproval.test.ts',
  'src/server/routes/people.test.ts',
  'src/server/routes/manage.test.ts',
  'src/server/routes/invites.test.ts',
  'src/server/routes/membershipRequests.test.ts',
  'src/server/invites/personRequests.test.ts',
  'src/server/admin/people.test.ts',
  'src/server/groups/linkRequests.test.ts',
  'src/server/groups/clientContract.test.ts',
  'src/server/routes/signup.test.ts',
  'src/server/routes/teamMembers.test.ts',
  'src/server/groups/follows.test.ts',
  'src/server/groups/guardianRequests.test.ts',
  'src/server/routes/teams.test.ts',
  'src/server/routes/games.test.ts',
  'src/server/routes/seasons.test.ts',
  'src/server/routes/seasonReaders.test.ts',
  'src/server/routes/me.test.ts',
  'src/server/routes/users.test.ts',
  'src/server/routes/media.test.ts',
  'src/server/routes/directorUploads.test.ts',
  'src/server/routes/directorUploadClock.test.ts',
  'src/server/media/ingestFile.test.ts',
  'src/server/events/eventInfo.test.ts',
  'src/server/middleware/withCors.test.ts',
  // The web session store's suite arrives with the phone cache.
  'src/app/platform/sessionStore.test.ts',
  'src/migrate/runner.test.ts',
  'src/migrate/upgrade.test.ts',
  'src/migrate/teamStation.test.ts',
  'src/common/screenScope.test.ts',
  'src/server/socket/screenScope.test.ts',
  'src/server/socket/syncRevision.test.ts',
  'src/server/socket/protocolAck.test.ts',
  'src/server/socket/writerNotices.test.ts',
  'src/server/socket/notifyRollback.test.ts',
  'src/app/sync/**/*.test.ts'
].filter(spec => spec.includes('*') || existsSync(spec))

const postgres = spawnSync('node', ['src/migrate/requirePostgres18.js'], {
  stdio: 'inherit'
})
if (postgres.status !== 0) process.exit(postgres.status ?? 1)

const build = spawnSync('node', ['scripts/build-scoring-tests.mjs'], {
  stdio: 'inherit'
})
if (build.status !== 0) process.exit(build.status ?? 1)

const test = spawnSync(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    '--extension',
    'ts',
    '--timeout',
    '20000',
    // Some suites leave handles open; coverage is written when it exits.
    '--exit',
    ...SPECS.flatMap(spec => ['--spec', spec]),
    '--spec',
    'lib/scoring-tests.cjs'
  ],
  { stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: temp } }
)

// Node caches multi-source bundle maps as file URLs. c8 compares filesystem
// paths before resolving each source, otherwise marking every bundled
// function covered. Normalize map identifiers, never counters.
for (const file of readdirSync(temp)) {
  const path = resolve(temp, file)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {})) {
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  }
  writeFileSync(path, JSON.stringify(data))
}

const report = spawnSync(
  'node_modules/.bin/c8',
  [
    'report',
    '--reporter=json',
    '--reports-dir',
    'coverage/sync',
    '--exclude',
    '**/*.test.*',
    '--exclude',
    '**/*.integration.ts',
    '--exclude',
    '**/*.e2e.ts',
    '--exclude',
    'src/test/**',
    '--exclude-after-remap'
  ],
  { stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: temp } }
)

// The files excluded are the ones mocha cannot load: the SQLite native
// adapter, the phone's session store and native root, and the server's
// entry point.
const check = spawnSync(
  'node',
  [
    'scripts/changed-line-check.cjs',
    '--coverage',
    'coverage/sync/coverage-final.json',
    '--ext',
    '.ts',
    '--ext',
    '.tsx',
    '--exclude',
    'src/app/sync/*.native.ts',
    '--exclude',
    'src/app/platform/sessionStore.native.ts',
    '--exclude',
    'src/app/native/index.tsx',
    '--exclude',
    'src/server/index.ts',
    'src/common',
    'src/server',
    'src/app',
    'src/migrate'
  ],
  { stdio: 'inherit' }
)

if (test.status !== 0) process.exit(test.status ?? 1)
if (report.status !== 0) process.exit(report.status ?? 1)
process.exit(check.status ?? 1)
