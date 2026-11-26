import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts,
  withoutTypeOnlyLines
} = require('./changed-line-coverage.cjs')
const combined = process.argv.includes('--combined')
const minimum = combined ? 95 : 90
const base = process.env.TS_COVERAGE_BASE ?? 'origin/develop'
const report = resolve(
  'coverage/notificationTabs',
  combined ? 'combined' : 'unit'
)
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
function run(command, args, env = {}) {
  const childEnv = { ...process.env, ...env }
  for (const key of Object.keys(childEnv))
    if (childEnv[key] == null) delete childEnv[key]
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: childEnv
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw Error(result.stderr)
  return result.stdout.trim()
}
const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .split('\n')
  .filter(Boolean)
const paths = [
  ...new Set([...git(['diff', '--name-only', base]).split('\n'), ...untracked])
].filter(
  path =>
    existsSync(path) &&
    /^src\/.+\.tsx?$/.test(path) &&
    !/\.(test|e2e|integration)\./.test(path) &&
    !path.startsWith('src/test/') &&
    !path.startsWith('src/server/dev/fixtures/')
)
const unit = [
  'src/common/observability/errors.test.ts',
  'src/server/notifications/inboxPage.test.ts',
  'src/server/notifications/inboxProjection.test.ts',
  'src/server/notifications/inbox.unit.test.ts',
  'src/server/notifications/pendingRequests.test.ts'
]
const integration = [
  'src/server/notifications/*.integration.test.ts',
  'src/server/groups/guardianRequests.integration.test.ts',
  'src/server/groups/noticePolicy.integration.test.ts',
  'src/server/groups/importedInvitations.integration.test.ts',
  'src/server/groups/clientContract.integration.test.ts',
  'src/server/groups/linkRequests.integration.test.ts',
  'src/server/groups/authority.integration.test.ts',
  'src/server/groups/parentTerms.integration.test.ts',
  'src/server/invites/personRequests.integration.test.ts',
  'src/server/routes/manage.integration.test.ts',
  'src/server/routes/people.integration.test.ts',
  'src/server/routes/membershipRequests.integration.test.ts',
  'src/server/routes/videographerRequests.integration.test.ts',
  'src/server/routes/phoneStreams.integration.test.ts',
  'src/server/routes/chatKeys.integration.test.ts',
  'src/server/schedule/gameRefinements.integration.test.ts',
  'src/server/schedule/gameApprovals.integration.test.ts',
  'src/server/schedule/seasonParticipantConsent.integration.test.ts',
  'src/server/schedule/teamSchedulingRoles.integration.test.ts',
  'src/server/umpires/umpireNotices.integration.test.ts',
  'src/server/users/derivedNames.integration.test.ts',
  'src/server/account/deleteAccount.integration.test.ts',
  'src/server/dev/fixtures/fixtures.integration.test.ts',
  'src/server/middleware/apiKeyCeiling.integration.test.ts',
  'src/migrate/migrations/094notificationIds.integration.test.ts',
  'src/migrate/migrations/132notificationInboxIndexes.integration.test.ts'
]
run(
  'node_modules/.bin/mocha',
  [
    '--exit',
    '--timeout',
    '180000',
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    ...unit,
    ...(combined ? integration : [])
  ],
  { NODE_V8_COVERAGE: temp, TS_NOTIFICATION_COVERAGE_ONLY: '1' }
)
if (combined) {
  console.log(
    'Uninstrumented real-Postgres performance gate: every warm read under 2000 ms'
  )
  run(
    'node_modules/.bin/mocha',
    [
      '--exit',
      '--timeout',
      '180000',
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      'src/server/notifications/inboxPages.integration.test.ts'
    ],
    { NODE_V8_COVERAGE: undefined, TS_NOTIFICATION_COVERAGE_ONLY: '0' }
  )
}
run('node', ['scripts/build-scoring-tests.mjs'])
run('node_modules/.bin/mocha', [
  '--exit',
  '--timeout',
  '120000',
  '-r',
  './src/test/scoringDomSetup.cjs',
  'lib/scoring-tests.cjs',
  '--grep',
  "guardian notifications|a notification that somebody added you|a reminder to upload a recording|a player added with a notice|a player's side removing them|notifications a page at a time|umpire notices"
])
run('node_modules/.bin/c8', [
  'report',
  '--all',
  '--extension',
  '.ts',
  '--extension',
  '.tsx',
  '--reporter=text',
  '--reporter=json',
  '--reports-dir',
  report,
  '--temp-directory',
  temp,
  '--exclude-after-remap',
  ...paths.flatMap(path => ['--include', path]),
  '--exclude',
  '**/*.test.*',
  '--exclude',
  'src/test/**'
])
const coverage = JSON.parse(
  readFileSync(resolve(report, 'coverage-final.json'), 'utf8')
)
const counts = {}
for (const path of paths) {
  const record = coverage[resolve(path)]
  if (record == null) throw Error('Missing instrumentation: ' + path)
  counts[path] = withoutTypeOnlyLines(
    path,
    readFileSync(path, 'utf8'),
    istanbulCounts(record)
  )
}
let diff = git(['diff', '--unified=0', base, '--', ...paths])
for (const path of untracked.filter(path => paths.includes(path))) {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
}
const changed = changedLines(diff)
const result = lineReportFromCounts(changed, counts, path =>
  paths.includes(path)
)
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify(result, null, 2)
)
const failed = []
for (const [path, lines] of Object.entries(result.files)) {
  const total = lines.covered.length + lines.uncovered.length
  const percent = total === 0 ? 100 : (100 * lines.covered.length) / total
  console.log(
    `${path}: ${percent.toFixed(2)}% (${lines.covered.length}/${total}); uncovered ${lines.uncovered.join(',')}`
  )
  if (combined && percent < minimum) failed.push(path)
}
console.log(
  `Notification tabs ${combined ? 'combined' : 'unit'} changed lines: ${result.percent.toFixed(2)}% (${result.covered}/${result.total})`
)
if (failed.length > 0 || result.percent < minimum || result.total === 0)
  throw Error(
    'Changed-line coverage below ' + minimum + '%: ' + failed.join(', ')
  )
// Unit coverage is an overall >=90% gate; SQL migrations remain honestly
// uncovered until integration. Combined coverage is >=95% for every file and
// overall. The canonical committed-tree check enforces that combined release
// gate. The working-tree
// check above includes new and uncommitted files during implementation too.
if (combined && git(['status', '--porcelain', '--', ...paths]) === '')
  run('node', [
    'scripts/changed-line-check.cjs',
    '--base',
    base,
    '--coverage',
    resolve(report, 'coverage-final.json'),
    '--report',
    resolve(report, 'committed-changed-lines.json'),
    '--ext',
    '.ts',
    '--min',
    String(minimum),
    ...paths
  ])
