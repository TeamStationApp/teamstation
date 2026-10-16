import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformSync } from 'esbuild'

const serverOnly = process.argv.includes('--phase=server')
const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error('Supply TS_COVERAGE_BASE for the follow-up commits')
const report = resolve('coverage/directActions')
rmSync(report, { recursive: true, force: true })
const temp = resolve(report, 'tmp')
mkdirSync(temp, { recursive: true })
function run(command, args, env = {}) {
  console.log('$', command, ...args)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .split('\n')
  .filter(Boolean)
const paths = [
  ...new Set([...git(['diff', '--name-only', base]).split('\n'), ...untracked])
].filter(path => {
  if (
    !existsSync(path) ||
    !/^src\/.+\.tsx?$/.test(path) ||
    /\.(test|e2e|integration|smoke)\./.test(path) ||
    /\.d\.ts$/.test(path)
  )
    return false
  if (serverOnly && path.startsWith('src/app/')) return false
  const { code } = transformSync(readFileSync(path, 'utf8'), {
    loader: path.endsWith('x') ? 'tsx' : 'ts',
    format: 'esm'
  })
  return (
    code.replace(/^\s*(export\s*\{\s*\};?|import\s[^;]*;)\s*$/gm, '').trim() !==
    ''
  )
})
run('node', ['src/migrate/requirePostgres18.js'])
const suites = [
  'src/server/schedule/seasonParticipantConsent.test.ts',
  'src/server/schedule/gameApprovals.test.ts',
  'src/server/schedule/batchApproval.test.ts',
  'src/server/schedule/teamSchedulingRoles.test.ts',
  'src/server/schedule/pendingProjection.test.ts',
  'src/server/groups/authority.test.ts',
  'src/server/groups/clientContract.test.ts',
  'src/server/groups/linkRequests.test.ts',
  'src/server/openapi.test.ts'
]
run(
  'node_modules/.bin/mocha',
  ['-r', 'sucrase/register', '--timeout', '60000', ...suites],
  { NODE_V8_COVERAGE: temp }
)
if (!serverOnly) {
  run('node', ['scripts/build-scoring-tests.mjs'])
  run(
    'node_modules/.bin/mocha',
    [
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      '--timeout',
      '60000',
      'lib/scoring-tests.cjs',
      '--grep',
      'direct action|actual app Create Game navigation|creation and organization interface behavior|settings people flows|success confirmation toast|game settings in the shared game scene|create game in the shared game scene'
    ],
    { NODE_V8_COVERAGE: temp }
  )
}
for (const name of readdirSync(temp)) {
  const file = resolve(temp, name)
  const value = JSON.parse(readFileSync(file, 'utf8'))
  for (const map of Object.values(value['source-map-cache'] ?? {}))
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  writeFileSync(file, JSON.stringify(value))
}
run('node_modules/.bin/c8', [
  'report',
  '--temp-directory',
  temp,
  '--reporter=text',
  '--reporter=json',
  '--reports-dir',
  report,
  '--exclude-after-remap',
  ...paths.flatMap(path => ['--include', path]),
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude',
  'src/test/**'
])
const require = createRequire(import.meta.url)
const map = require('istanbul-lib-coverage').createCoverageMap(
  JSON.parse(readFileSync(resolve(report, 'coverage-final.json'), 'utf8'))
)
if (process.env.TS_DIRECT_BROWSER_COVERAGE != null)
  map.merge(
    JSON.parse(readFileSync(process.env.TS_DIRECT_BROWSER_COVERAGE, 'utf8'))
  )
writeFileSync(
  resolve(report, 'coverage-final.json'),
  JSON.stringify(map.toJSON())
)
let diff = git(['diff', '--unified=0', base, '--', ...paths])
for (const path of untracked.filter(path => paths.includes(path))) {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
}
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
const counts = {}
for (const path of paths)
  if (map.files().includes(resolve(path)))
    counts[path] = istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
const result = lineReportFromCounts(changedLines(diff), counts, path =>
  paths.includes(path)
)
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify(result, null, 2)
)
const failures = []
for (const [path, lines] of Object.entries(result.files)) {
  const total = lines.covered.length + lines.uncovered.length
  if (total === 0) continue
  const percent = (lines.covered.length / total) * 100
  console.log(
    `${path}: ${percent.toFixed(2)}% (${lines.covered.length}/${total})${lines.uncovered.length ? ' uncovered ' + lines.uncovered.join(',') : ''}`
  )
  if (percent < 90) failures.push(path)
}
console.log(
  `Direct actions changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total})`
)
if (failures.length || !result.pass || result.total === 0)
  throw new Error(
    `At least 90% changed runtime coverage required: ${failures.join(', ')}`
  )
