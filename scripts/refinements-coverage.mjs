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
import ts from 'typescript'

import { webSettings } from './web-build-settings.mjs'

const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error('Set TS_COVERAGE_BASE to the reviewed parent commit')
const phase = process.env.TS_REFINEMENTS_PHASE ?? 'finished'
const report = resolve('coverage/refinements')
const temp = resolve(report, 'tmp')
rmSync(temp, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
mkdirSync('lib', { recursive: true })
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}
const m1Paths = [
  'src/common/gameApprovals.ts',
  'src/common/scheduleGames.ts',
  'src/server/groups/requests.ts',
  'src/server/routes/gameApprovals.ts',
  'src/server/schedule/gameApprovals.ts',
  'src/server/schedule/gameApprovalOpenApi.ts',
  'src/server/schedule/scheduleGames.ts',
  'src/server/notifications/requestInformation.ts'
]
const m2Paths = [
  ...m1Paths,
  'src/common/api.ts',
  'src/common/publicGroups.ts',
  'src/common/seasonStandings.ts',
  'src/server/index.ts',
  'src/server/openapi.ts',
  'src/server/groups/publicSummary.ts',
  'src/server/invites/people.ts',
  'src/server/routes/eventList.ts',
  'src/server/routes/manage.ts',
  'src/server/routes/seasons.ts',
  'src/server/routes/stats.ts',
  'src/server/routes/teams.ts',
  'src/server/schedule/pendingProjection.ts',
  'src/server/stats/records.ts',
  'src/server/stats/seasonTeams.ts'
]
const serverOnly = phase === 'M1' || phase === 'M2'
const uiOnly = process.env.TS_REFINEMENTS_UI_ONLY === '1'
if (uiOnly && serverOnly)
  throw new Error('UI-only coverage requires the finished phase')
const m1Suites = [
  'src/migrate/seasonGameRefinements.test.ts',
  'src/server/schedule/gameRefinements.test.ts',
  'src/server/schedule/gameScopeSocket.test.ts',
  'src/server/schedule/gameApprovals.test.ts',
  'src/server/schedule/batchApproval.test.ts',
  'src/server/schedule/scheduleGames.test.ts',
  'src/server/groups/gameApprovalGate.test.ts',
  'src/common/scheduleGames.test.ts',
  'src/server/openapi.test.ts',
  'src/server/groups/externalCustody.test.ts',
  ...globSync('src/server/notifications/*.test.ts')
]
const serverSuites = [
  ...m1Suites,
  'src/server/schedule/pendingProjection.test.ts',
  'src/common/api.test.ts',
  'src/common/seasonStandings.test.ts',
  'src/server/routes/seasonReaders.test.ts',
  'src/server/routes/seasons.test.ts',
  'src/server/routes/stats.test.ts',
  'src/server/routes/manage.test.ts',
  'src/server/stats/records.test.ts',
  'src/server/groups/publicSummary.test.ts',
  'src/server/groups/teamMerge.test.ts',
  'src/server/groups/ownershipPreflight.test.ts',
  'src/server/groups/creation.test.ts',
  'src/server/groups/linkRequests.test.ts',
  'src/server/groups/clientContract.test.ts',
  'src/server/groups/authority.test.ts',
  'src/server/groups/competitionAuthority.test.ts',
  'src/server/groups/adminGuard.test.ts',
  'src/server/groups/importedInvitations.test.ts',
  'src/server/groups/externalCustody.test.ts',
  'src/server/routes/eventListQuery.test.ts',
  'src/server/routes/eventList.test.ts',
  'src/server/openapi.test.ts',
  'src/app/components/iconFont.test.ts',
  ...globSync('src/server/notifications/*.test.ts')
].filter(path => globSync(path).length > 0)
const uiSuites = [
  'src/app/screens/GameFormScreen.edit.test.tsx',
  'src/app/screens/GameFormScreen.create.test.tsx',
  'src/app/components/SuccessToast.test.tsx',
  'src/app/screens/gameTabs.test.ts',
  'src/app/navigation/routes.test.ts',
  'src/app/navigation/seasonParticipant.test.ts',
  'src/app/screens/SeasonScreen.test.tsx',
  'src/app/screens/SeasonPresentation.test.tsx',
  'src/app/screens/SeasonStandings.test.tsx',
  'src/app/screens/creationUi.test.tsx',
  'src/app/screens/HomeScreen.test.tsx',
  'src/app/screens/HomeScreen.recentGame.test.tsx',
  'src/app/screens/GamesFeedScreen.test.tsx',
  'src/app/screens/TeamScreen.pending.test.tsx',
  'src/app/screens/TeamPage.test.tsx',
  'src/app/screens/PublicTeamContent.test.tsx',
  'src/app/screens/GroupSettingsScreen.test.tsx',
  'src/app/screens/gameListOptions.test.ts',
  'src/app/components/GameHeroCard.test.tsx',
  'src/app/screens/gameCreation.test.tsx',
  'src/app/screens/groupCreation.test.tsx',
  'src/app/screens/ManageScreen.test.tsx',
  'src/app/screens/expandedStats.test.tsx',
  'src/app/components/AppNav.test.tsx',
  'src/app/components/SegmentedPill.test.tsx',
  'src/app/components/ScheduleRow.test.tsx',
  'src/app/components/StickySectionLayout.test.tsx',
  'src/app/components/StickySectionLayout.native.test.tsx',
  'src/app/components/FrozenNameTable.test.tsx',
  'src/app/App.teamRoutes.test.tsx',
  'src/app/components/GameRow.test.tsx'
].filter(path => globSync(path).length > 0)
const changed = git(['diff', '--name-only', base]).trim().split('\n')
const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .trim()
  .split('\n')
// Type declarations and forwarding exports have no executable source lines.
// Their exported implementations are still gated in their defining files.
function hasExecutableSource(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  return source.statements.some(
    statement =>
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isExportDeclaration(statement) &&
      !(
        ts.isImportDeclaration(statement) &&
        statement.importClause?.isTypeOnly === true
      )
  )
}
const eligible = path =>
  /^src\/.+\.tsx?$/.test(path) &&
  !/\.(test|integration|e2e)\./.test(path) &&
  !path.startsWith('src/test/') &&
  !path.startsWith('src/migrate/') &&
  path !== 'src/server/db/database.ts' &&
  hasExecutableSource(path)
const paths =
  phase === 'M1'
    ? m1Paths
    : phase === 'M2'
      ? m2Paths
      : [...new Set([...changed, ...untracked])].filter(eligible)
if (paths.length === 0) throw new Error('No changed runtime files to measure')
if (!serverOnly)
  await build({
    ...webSettings,
    stdin: {
      contents: uiSuites.map(path => `import './${path}'`).join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'refinements-tests.ts'
    },
    outfile: 'lib/refinements-tests.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: true,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'jsdom', 'mocha', 'chai'],
    define: {
      __DEV__: 'true',
      TS_API_BASE_URL: JSON.stringify('/api/v1'),
      'process.env.NODE_ENV': JSON.stringify('test')
    },
    loader: { '.png': 'dataurl', '.svg': 'dataurl' }
  })
run('node', ['src/migrate/requirePostgres18.js'])
run(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    '--timeout',
    '60000',
    ...(uiOnly ? [] : phase === 'M1' ? m1Suites : serverSuites),
    ...(serverOnly ? [] : ['lib/refinements-tests.cjs'])
  ],
  { NODE_V8_COVERAGE: temp }
)
if (phase !== 'M1' && !uiOnly)
  run(
    'node',
    ['-r', 'sucrase/register', 'src/test/refinementsStartup.e2e.ts'],
    { TS_REFINEMENTS_STARTUP_V8: temp }
  )
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
  ...paths.flatMap(path => ['--include', path]),
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.integration.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude',
  'src/test/**'
])
const require = createRequire(import.meta.url)
const map = require('istanbul-lib-coverage').createCoverageMap(
  JSON.parse(readFileSync(resolve(report, 'coverage-final.json'), 'utf8'))
)
if (phase !== 'M1' && process.env.TS_REFINEMENTS_BROWSER_COVERAGE != null) {
  map.merge(
    JSON.parse(
      readFileSync(process.env.TS_REFINEMENTS_BROWSER_COVERAGE, 'utf8')
    )
  )
}
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
  const lines = readFileSync(path, 'utf8').split('\n').length - 1
  diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n`
  diff +=
    readFileSync(path, 'utf8')
      .split('\n')
      .slice(0, lines)
      .map(line => '+' + line)
      .join('\n') + '\n'
}
const counts = {}
for (const path of paths) {
  if (map.files().includes(resolve(path)))
    counts[path] = istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
}
const result = lineReportFromCounts(changedLines(diff), counts, path =>
  paths.includes(path)
)
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify(result, null, 2)
)
for (const [path, lines] of Object.entries(result.files)) {
  const total = lines.covered.length + lines.uncovered.length
  if (total > 0 && lines.covered.length / total < 0.9)
    throw new Error(
      `${path}: changed runtime lines below90% (${lines.covered.length}/${total})`
    )
}
if (result.total === 0 || !result.pass)
  throw new Error(
    `Changed runtime coverage must be >=90%: ${JSON.stringify(result)}`
  )
console.log(
  `Refinements changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total} lines), base ${base}`
)
