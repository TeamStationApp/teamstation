import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const report = resolve('coverage/apiKeys')
const temp = resolve(report, `v8-${Date.now()}`)
mkdirSync(temp, { recursive: true })
const base = process.env.TS_COVERAGE_BASE ?? 'origin/develop'
const artifacts = process.env.TS_ARTIFACTS_DIR
if (artifacts == null) throw new Error('Supply TS_ARTIFACTS_DIR')
function run(command, args, env = {}) {
  console.log('$', command, ...args)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, NODE_V8_COVERAGE: temp, ...env }
  })
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.status}`)
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
// The fork point, so what develop changed since does not count as this branch's.
const forkPoint = git(['merge-base', base, 'HEAD'])
const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .split('\n')
  .filter(Boolean)
const paths = [
  ...new Set([
    ...git(['diff', '--name-only', forkPoint]).split('\n'),
    ...untracked
  ])
].filter(
  path =>
    /^src\/.+\.tsx?$/.test(path) &&
    !/\.(test|e2e|integration)\./.test(path) &&
    !path.startsWith('src/test/')
)
run('node', ['scripts/build-scoring-tests.mjs'])
run('node_modules/.bin/mocha', [
  '-r',
  'sucrase/register',
  '-r',
  './src/test/scoringDomSetup.cjs',
  '--timeout',
  '60000',
  '--exit',
  'lib/scoring-tests.cjs',
  '--grep',
  'NodeSettingsCard|node administration'
])
run('node_modules/.bin/mocha', [
  '-r',
  'sucrase/register',
  '--timeout',
  '60000',
  '--exit',
  'src/server/aiKey*.test.ts',
  'src/server/serverConfig.test.ts',
  'src/server/nodeSettings.test.ts',
  'src/common/nodeSettings.test.ts',
  'src/common/observability/errors.test.ts',
  'src/server/tess/messagesApi.test.ts',
  'src/server/tess/denyList.test.ts',
  'src/server/dictation/*.test.ts',
  'src/server/replay/speech.test.ts',
  'src/server/routes/health.test.ts',
  'src/server/replay/narrationAudio.test.ts',
  'src/server/routes/tess.test.ts',
  'src/server/openapi.test.ts'
])
reportCoverage(false)
// Always serve a web build made from this same source revision.
run('npm', ['run', 'build.web'])
// The browser and real entry point add counters from the same source revision.
run('node_modules/.bin/mocha', [
  '-r',
  'sucrase/register',
  '--timeout',
  '180000',
  'src/test/apiKeyArrays.e2e.ts'
])
run('node', ['-r', 'sucrase/register', 'src/test/refinementsStartup.e2e.ts'], {
  TS_REFINEMENTS_ARTIFACTS: artifacts,
  TS_REFINEMENTS_STARTUP_V8: temp
})
reportCoverage(true)

function reportCoverage(combined) {
  const stageReport = combined ? report : resolve(report, 'unit')
  mkdirSync(stageReport, { recursive: true })
  for (const file of readdirSync(temp)) {
    if (!file.endsWith('.json')) continue
    const path = resolve(temp, file)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    for (const map of Object.values(value['source-map-cache'] ?? {}))
      if (map.data?.sources != null)
        map.data.sources = map.data.sources.map(source =>
          source.startsWith('file://') ? fileURLToPath(source) : source
        )
    writeFileSync(path, JSON.stringify(value))
  }
  run('node_modules/.bin/c8', [
    'report',
    '--all',
    '--temp-directory',
    temp,
    '--reporter=text',
    '--reporter=json',
    '--reports-dir',
    stageReport,
    '--exclude-after-remap',
    ...paths.flatMap(path => ['--include', path]),
    '--exclude',
    '**/*.test.*',
    '--exclude',
    '**/*.e2e.*',
    '--exclude',
    'src/test/**'
  ])
  const map = require('istanbul-lib-coverage').createCoverageMap(
    JSON.parse(
      readFileSync(resolve(stageReport, 'coverage-final.json'), 'utf8')
    )
  )
  if (combined)
    map.merge(
      JSON.parse(
        readFileSync(resolve(artifacts, 'browser-coverage.json'), 'utf8')
      )
    )
  writeFileSync(
    resolve(stageReport, 'coverage-final.json'),
    JSON.stringify(map.toJSON())
  )
  const {
    changedLines,
    istanbulCounts,
    lineReportFromCounts,
    withoutTypeOnlyLines
  } = require('./changed-line-coverage.cjs')
  let diff = git(['diff', '--unified=0', forkPoint, '--', ...paths])
  for (const path of untracked.filter(path => paths.includes(path))) {
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
  }
  const counts = {}
  for (const path of paths)
    if (map.files().includes(resolve(path)))
      counts[path] = withoutTypeOnlyLines(
        path,
        readFileSync(path, 'utf8'),
        istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
      )
  const result = lineReportFromCounts(
    changedLines(diff),
    counts,
    path => paths.includes(path),
    { min: combined ? 95 : 90 }
  )
  writeFileSync(
    resolve(stageReport, 'changed-lines.json'),
    JSON.stringify(result, null, 2)
  )
  const failures = []
  for (const [path, lines] of Object.entries(result.files)) {
    const total = lines.covered.length + lines.uncovered.length
    const percent = total === 0 ? 100 : (lines.covered.length / total) * 100
    console.log(
      `${path}: ${percent.toFixed(2)}% uncovered ${lines.uncovered.join(',')}`
    )
    if (combined && percent < 95) failures.push(path)
  }
  console.log(
    `${combined ? 'Combined' : 'Unit-only'} changed executable-line coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total})`
  )
  if (failures.length > 0 || !result.pass || result.total === 0)
    throw new Error(
      `${combined ? '95% per file and overall' : '90% overall'} required: ${failures.join(', ')}; missing: ${result.missing.join(', ')}`
    )
}
