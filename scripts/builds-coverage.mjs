import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const required = [
  'src/server/oauth/adapter.ts',
  'src/server/oauth/config.ts',
  'src/server/oauth/maintenance.ts',
  'src/server/oauth/provider.ts',
  'src/server/oauth/routes.ts',
  'src/migrate/migrations/050oauth.ts',
  'src/common/distribution.ts',
  'src/app/oauth/approvalClient.ts',
  'src/app/screens/OAuthScreen.tsx',
  'src/app/components/BuildInfoModal.tsx',
  'src/app/platform/externalBrowser.ts',
  'src/app/platform/externalBrowser.native.ts',
  'scripts/build-info.cjs'
]
const reportDir = resolve('coverage/builds')
const temp = resolve(reportDir, 'tmp')
rmSync(reportDir, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
const env = { ...process.env, NODE_V8_COVERAGE: temp }
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(process.execPath, ['scripts/build-builds-ui-tests.mjs'])
run('node_modules/.bin/mocha', [
  '-r',
  'sucrase/register',
  '-r',
  './src/test/scoringDomSetup.cjs',
  'lib/builds-tests.cjs',
  'src/common/distribution.test.ts',
  'src/common/buildInfoGenerator.test.ts',
  'src/app/navigation/routes.test.ts'
])
run('node_modules/.bin/mocha', [
  '-r',
  'sucrase/register',
  'src/server/oauth/oauth.test.ts',
  'src/server/openapi.test.ts'
])
// Migration tests run separately: application database setup changes pg's
// bigint parser, while migration-only assertions deliberately use pg defaults.
run('node_modules/.bin/mocha', [
  '-r',
  'sucrase/register',
  'src/migrate/runner.test.ts',
  'src/migrate/upgrade.test.ts'
])
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
  '--reporter=text',
  '--reporter=json',
  '--reporter=json-summary',
  '--reporter=lcov',
  '--reports-dir',
  reportDir,
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.integration.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude',
  'src/test/**',
  '--exclude-after-remap',
  ...[
    ...required,
    'src/common/api.ts',
    'src/app/components/AppHeader.tsx',
    'src/app/App.tsx',
    'src/app/navigation/routes.ts',
    'src/app/locales/en_US.ts',
    'src/server/routes/me.ts',
    'src/server/auth/sessions.ts',
    'src/server/index.ts',
    'src/server/serverConfig.ts',
    'src/server/openapi.ts',
    'src/migrate/migrations/index.ts'
  ].flatMap(file => ['--include', file])
])
const summary = JSON.parse(
  readFileSync(resolve(reportDir, 'coverage-summary.json'), 'utf8')
)
for (const file of required) {
  const count = summary[resolve(file)]?.lines
  if (count == null || count.total === 0 || count.pct < 90)
    throw new Error(
      `${file}: expected mapped line coverage >= 90%, got ${JSON.stringify(count)}`
    )
}

// Gate changed executable lines as well as every new module.
const { changedLines, istanbulCounts, lineReportFromCounts } =
  await import('./changed-line-coverage.cjs')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const baseline =
  process.env.BUILDS_COVERAGE_BASE ??
  git('merge-base', 'HEAD', 'origin/master').trim()
const changes = Object.fromEntries(
  Object.entries(changedLines(git('diff', '--unified=0', baseline))).filter(
    ([file]) =>
      /^src\/(app|common|server|migrate)\/.*\.tsx?$/.test(file) &&
      !/\.(test|integration|e2e)\./.test(file)
  )
)
const coverage = JSON.parse(
  readFileSync(resolve(reportDir, 'coverage-final.json'), 'utf8')
)
const counts = Object.fromEntries(
  Object.keys(changes).map(file => [
    file,
    coverage[resolve(file)] == null
      ? undefined
      : istanbulCounts(coverage[resolve(file)])
  ])
)
const added = git('diff', '--name-only', '--diff-filter=A', baseline)
  .trim()
  .split('\n')
  .filter(file => file in changes)
const report = lineReportFromCounts(changes, counts, () => true, {
  newFiles: added,
  newFileMin: 90
})
console.log(
  `New builds work: ${report.covered}/${report.total} executable lines (${report.percent.toFixed(2)}%)`
)
writeFileSync(
  resolve(reportDir, 'changed-lines.json'),
  JSON.stringify(report, null, 2)
)
if (!report.pass)
  throw new Error(`New-work coverage failed: ${JSON.stringify(report)}`)
