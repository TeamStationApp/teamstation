import { spawnSync } from 'node:child_process'
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import gateModule from './observability-line-gate.cjs'
import counters from './changed-line-coverage.cjs'

const { snapshot, gate } = gateModule
const before = snapshot()
const directory = 'coverage/observability'
mkdirSync(directory, { recursive: true })
const tests = [
  ...globSync('src/**/observability/*.test.ts'),
  ...globSync('src/logServer/*.test.ts'),
  'src/server/account/deleteAccount.test.ts',
  'src/server/jsonBody.test.ts',
  'src/server/serverConfig.test.ts',
  'src/server/openapi.test.ts',
  'scripts/observability-line-gate.test.cjs'
]
const include = [
  'src/common/observability/*.ts',
  'src/server/observability/*.ts',
  'src/logServer/*.ts',
  'scripts/observability-line-gate.cjs',
  'src/migrate/migrations/077analyticsEvents.ts',
  'src/migrate/migrations/index.ts',
  'src/server/account/deleteAccount.ts',
  'src/server/jsonBody.ts',
  'src/server/serverConfig.ts',
  'src/server/openapi.ts',
  'src/server/index.ts'
]
const args = [
  'node_modules/.bin/c8',
  '--all',
  '--reporter=text',
  '--reporter=json',
  '--report-dir',
  directory,
  ...include.flatMap(path => ['--include', path]),
  '--exclude',
  '**/*.test.*',
  'node',
  'node_modules/mocha/bin/mocha.js',
  '--timeout',
  '30000',
  '--exit',
  '-r',
  'sucrase/register',
  ...tests
]
console.log('$ node ' + args.join(' '))
const result = spawnSync('node', args, { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
const coverage = JSON.parse(
  readFileSync(resolve(directory, 'coverage-final.json'), 'utf8')
)
const counts = Object.fromEntries(
  Object.entries(coverage).map(([path, entry]) => [
    path,
    counters.istanbulCounts(entry)
  ])
)
const report = gate(
  before,
  counts,
  path =>
    /^src\/(common|server)\/observability\//.test(path) ||
    path.startsWith('src/logServer/') ||
    include.includes(path) ||
    path === 'scripts/observability-line-gate.cjs'
)
writeFileSync(
  resolve(directory, 'gate.json'),
  JSON.stringify({ stamp: before.stamp, report }, null, 2)
)
