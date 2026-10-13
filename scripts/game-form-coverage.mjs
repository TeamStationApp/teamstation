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

/**
 * Changed-line coverage for Create Game and Game Settings.
 *
 * `--phase=server` runs the server suites and measures the changed files
 * outside `src/app/`; `--phase=ui` runs the bundled UI suites and measures
 * the changed files under it. Each phase keeps its own V8 output, so one
 * stands without the other; with no phase, both run and every changed file
 * counts. `GAME_FORM_BROWSER_COVERAGE` merges the browser run's coverage.
 */
const phase =
  process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) ?? 'finished'
if (!['server', 'ui', 'finished'].includes(phase))
  throw new Error(`Unknown phase ${phase}`)
const report = resolve('coverage/gameForm')
const temps = {
  server: resolve(report, 'tmp-server'),
  ui: resolve(report, 'tmp-ui')
}
const running = phase === 'finished' ? ['server', 'ui'] : [phase]
for (const name of running) {
  rmSync(temps[name], { recursive: true, force: true })
  mkdirSync(temps[name], { recursive: true })
}
function run(command, args, env = {}) {
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
const base =
  process.env.TS_COVERAGE_BASE ?? git(['merge-base', 'origin/master', 'HEAD'])
const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .split('\n')
  .filter(Boolean)
const paths = [
  ...new Set([...git(['diff', '--name-only', base]).split('\n'), ...untracked])
].filter(
  path =>
    existsSync(path) &&
    /^src\/(app|common|server)\//.test(path) &&
    /\.tsx?$/.test(path) &&
    !/\.(test|e2e|smoke)\./.test(path) &&
    !/\.d\.ts$/.test(path) &&
    (phase === 'finished' || (phase === 'ui') === path.startsWith('src/app/'))
)
const serverSuites = [
  'src/server/groups/relatedTeams.test.ts',
  'src/server/groups/creation.test.ts',
  'src/server/groups/clientContract.test.ts',
  'src/server/groups/follows.test.ts',
  'src/server/groups/leagueDetail.test.ts',
  'src/common/api.test.ts',
  'src/common/gameApprovals.test.ts',
  'src/server/notifications/requestInformation.test.ts',
  'src/server/openapi.test.ts',
  'src/common/eventInfo.test.ts',
  'src/server/events/eventInfo.test.ts',
  'src/server/routes/seasonReaders.test.ts',
  'src/server/schedule/pendingProjection.test.ts'
].filter(existsSync)
run('node', ['src/migrate/requirePostgres18.js'])
if (running.includes('server'))
  run(
    'node_modules/.bin/mocha',
    ['-r', 'sucrase/register', '--timeout', '60000', ...serverSuites],
    { NODE_V8_COVERAGE: temps.server }
  )
if (running.includes('ui')) {
  run('node', ['scripts/build-game-form-tests.mjs'])
  run(
    'node_modules/.bin/mocha',
    [
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      '--timeout',
      '60000',
      'lib/game-form-tests.cjs'
    ],
    { NODE_V8_COVERAGE: temps.ui }
  )
}
const measured = phase === 'finished' ? ['server', 'ui'] : [phase]
const merged = resolve(report, 'tmp-merged')
rmSync(merged, { recursive: true, force: true })
mkdirSync(merged, { recursive: true })
for (const name of measured)
  for (const file of readdirSync(temps[name])) {
    const data = JSON.parse(readFileSync(resolve(temps[name], file), 'utf8'))
    for (const map of Object.values(data['source-map-cache'] ?? {})) {
      if (map.data?.sources != null)
        map.data.sources = map.data.sources.map(source =>
          source.startsWith('file://') ? fileURLToPath(source) : source
        )
    }
    writeFileSync(resolve(merged, `${name}-${file}`), JSON.stringify(data))
  }
if (paths.length === 0) throw new Error('No changed runtime files to measure')
run('node_modules/.bin/c8', [
  'report',
  '--temp-directory',
  merged,
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
if (process.env.GAME_FORM_BROWSER_COVERAGE != null)
  map.merge(
    JSON.parse(readFileSync(process.env.GAME_FORM_BROWSER_COVERAGE, 'utf8'))
  )
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
  const source = readFileSync(path, 'utf8')
  const lines = source.trimEnd().split('\n')
  diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
}
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
const failures = Object.entries(result.files).filter(([, lines]) => {
  const total = lines.covered.length + lines.uncovered.length
  return total > 0 && lines.covered.length / total < 0.9
})
for (const [path, lines] of Object.entries(result.files)) {
  const total = lines.covered.length + lines.uncovered.length
  if (total > 0)
    console.log(
      `${path}: ${((lines.covered.length / total) * 100).toFixed(1)}% (${lines.covered.length}/${total})${lines.uncovered.length > 0 ? ' uncovered ' + lines.uncovered.join(',') : ''}`
    )
}
console.log(
  `Game form changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total} lines)`
)
if (failures.length > 0 || !result.pass || result.total === 0)
  throw new Error(
    `At least 90% changed runtime line coverage required: ${JSON.stringify(failures.map(([path]) => path))}`
  )
