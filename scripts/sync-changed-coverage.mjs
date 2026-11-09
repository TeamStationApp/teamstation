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
// socket, their notices, and the phone's cache and outbox. One mocha process
// runs the suites those changes can reach, server and app together, under
// NODE_V8_COVERAGE. The gate reads `git merge-base origin/master HEAD` to
// HEAD, so it runs after the milestone is committed.
const temp = resolve('coverage/sync/tmp')
rmSync(resolve('coverage/sync'), { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

const SPECS = [
  'src/common/gameSocket.test.ts',
  'src/server/socket/gameSocket.integration.test.ts',
  'src/server/socket/fanout.integration.test.ts',
  'src/server/schedule/gameScopeSocket.integration.test.ts',
  'src/server/routes/events.integration.test.ts',
  'src/server/routes/lineups.integration.test.ts',
  'src/server/routes/rosterCreation.integration.test.ts',
  'src/server/routes/players.integration.test.ts',
  'src/server/routes/live.integration.test.ts',
  'src/server/live/finishStream.integration.test.ts',
  'src/server/live/reconnectGrace.integration.test.ts',
  'src/server/live/sync.integration.test.ts',
  'src/server/live/syncOnce.test.ts',
  'src/server/live/wallAnchors.integration.test.ts',
  'src/server/routes/phoneStreams.integration.test.ts',
  'src/server/groups/liveAuthority.integration.test.ts',
  'src/server/groups/liveRevocationRecording.integration.test.ts',
  'src/server/director/purge.integration.test.ts',
  'src/common/api.test.ts',
  'src/server/routes/schedule.integration.test.ts',
  'src/server/schedule/scheduleGames.integration.test.ts',
  'src/server/schedule/gameRefinements.integration.test.ts',
  'src/server/schedule/batchApproval.integration.test.ts',
  'src/server/routes/people.integration.test.ts',
  'src/server/routes/manage.integration.test.ts',
  'src/server/routes/invites.integration.test.ts',
  'src/server/routes/membershipRequests.integration.test.ts',
  'src/server/invites/personRequests.integration.test.ts',
  'src/server/admin/people.integration.test.ts',
  'src/server/groups/linkRequests.integration.test.ts',
  'src/server/groups/clientContract.integration.test.ts',
  'src/server/routes/signup.integration.test.ts',
  'src/server/routes/teamMembers.integration.test.ts',
  'src/server/groups/follows.integration.test.ts',
  'src/server/groups/guardianRequests.integration.test.ts',
  'src/server/routes/teams.integration.test.ts',
  'src/server/routes/games.integration.test.ts',
  'src/server/routes/seasons.integration.test.ts',
  'src/server/routes/seasonReaders.integration.test.ts',
  'src/server/routes/me.integration.test.ts',
  'src/server/routes/users.integration.test.ts',
  'src/server/routes/media.test.ts',
  'src/server/routes/directorUploads.integration.test.ts',
  'src/server/routes/directorUploadClock.integration.test.ts',
  'src/server/media/ingestFile.integration.test.ts',
  'src/server/events/eventInfo.integration.test.ts',
  'src/server/middleware/withCors.test.ts',
  // The web session store's suite arrives with the phone cache.
  'src/app/platform/sessionStore.test.ts',
  'src/migrate/runner.integration.test.ts',
  'src/migrate/upgrade.integration.test.ts',
  'src/migrate/teamStation.integration.test.ts',
  'src/common/screenScope.test.ts',
  'src/server/socket/screenScope.integration.test.ts',
  'src/server/socket/syncRevision.integration.test.ts',
  'src/server/socket/protocolAck.integration.test.ts',
  'src/server/socket/writerNotices.integration.test.ts',
  'src/server/socket/notifyRollback.integration.test.ts',
  'src/server/routes/syncIdempotency.integration.test.ts',
  // Pictures: public names, unsigned URLs, and the republish at start.
  'src/server/media/imageUrls.test.ts',
  'src/server/media/images.integration.test.ts',
  'src/server/media/republishImages.integration.test.ts',
  'src/server/media/pictureCatalog.integration.test.ts',
  'src/server/routes/teamsOf.integration.test.ts',
  'src/server/chat/chat2Identity.integration.test.ts',
  'src/server/routes/venues.integration.test.ts',
  'src/server/account/deleteAccount.integration.test.ts',
  'src/server/routes/account.integration.test.ts',
  'src/server/routes/account.chatAge.integration.test.ts',
  'src/server/dev/fakeSpace.test.ts',
  'src/server/routes/pictures.integration.test.ts',
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
