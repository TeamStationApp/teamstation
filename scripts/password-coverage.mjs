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

import { build } from 'esbuild'

import { webSettings } from './web-build-settings.mjs'

const suites = ['src/app/screens/AccountScreen.test.tsx']
const required = [
  'src/app/components/NewPasswordFields.tsx',
  'src/common/passwordCalibration.ts',
  'src/common/passwordProtocol.ts'
]
const reportDir = resolve('coverage/password')
const temp = resolve(reportDir, 'tmp')
rmSync(reportDir, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
mkdirSync('lib', { recursive: true })
await build({
  ...webSettings,
  stdin: {
    contents: suites.map(file => `import './${file}'`).join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'account-test-entry.ts'
  },
  outfile: 'lib/password-tests.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  jsx: 'automatic',
  external: [
    'react',
    'react-dom',
    'three',
    '@react-three/fiber',
    '@react-three/test-renderer',
    'jsdom',
    'mocha',
    'chai'
  ],
  sourcemap: true,
  define: {
    __DEV__: 'true',
    TS_API_BASE_URL: JSON.stringify('/api/v1'),
    'process.env.NODE_ENV': JSON.stringify('test')
  },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
})
const env = { ...process.env, NODE_V8_COVERAGE: temp }
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run('node_modules/.bin/mocha', [
  '-r',
  'sucrase/register',
  '-r',
  './src/test/scoringDomSetup.cjs',
  'src/server/routes/password.test.ts',
  'src/server/routes/account.test.ts',
  'src/server/openapi.test.ts',
  'src/server/auth/passwords.test.ts',
  'src/common/passwordCalibration.test.ts',
  'src/common/passwordProtocol.test.ts',
  'src/common/passwordClient.test.ts',
  '--grep',
  'password|Password|Argon2',
  'lib/password-tests.cjs'
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
  '--reports-dir',
  reportDir,
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude',
  'src/test/**',
  '--exclude-after-remap',
  ...[
    ...required,
    'src/app/screens/AccountScreen.tsx',
    'src/app/components/TextField.tsx',
    'src/server/auth/passwords.ts',
    'src/common/api.ts',
    'src/server/routes/auth.ts',
    'src/server/jsonBody.ts',
    'src/server/openapi.ts',
    'src/app/App.tsx',
    'src/app/components/AppHeader.tsx'
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

// Limit this report to the current increment; the account feature has its own gate.
const { changedLines, istanbulCounts, lineReportFromCounts } =
  await import('./changed-line-coverage.cjs')
const baseline =
  process.env.PASSWORD_COVERAGE_BASE ??
  '53009c5efc5fbb5bdda166decd59f3bf4bb78e7f'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const changes = Object.fromEntries(
  Object.entries(changedLines(git('diff', '--unified=0', baseline))).filter(
    ([file]) =>
      /^src\/(app|common|server)\/.*\.tsx?$/.test(file) &&
      !/\.(test|e2e)\./.test(file)
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
  `New password work: ${report.covered}/${report.total} executable lines (${report.percent.toFixed(2)}%)`
)
writeFileSync(
  resolve(reportDir, 'changed-lines.json'),
  JSON.stringify(report, null, 2)
)
if (!report.pass)
  throw new Error(`New-work coverage failed: ${JSON.stringify(report)}`)
