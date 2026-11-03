import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = process.env.TS_COVERAGE_BASE
if (base == null) throw new Error('Supply TS_COVERAGE_BASE for this task')
const report = resolve('coverage/gameStatistics')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
function run(command, args, env = {}) {
  console.log('$', command, ...args)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run('node', ['scripts/build-scoring-tests.mjs'])
const common = [
  '-r',
  'sucrase/register',
  '-r',
  './src/test/scoringDomSetup.cjs',
  '--timeout',
  '60000',
  '--exit'
]
run(
  'node_modules/.bin/mocha',
  [
    ...common,
    'src/common/gameStatistics.test.ts',
    'src/common/replay/*.test.ts',
    'src/server/scoring/gameStatistics.test.ts',
    'src/server/openapi.test.ts',
    'src/app/tv/replayStatistics.test.ts',
    'src/app/tv/playbackTimeline.test.ts',
    'src/app/replay/replayMachine.test.ts'
  ],
  { NODE_V8_COVERAGE: temp }
)
run(
  'node_modules/.bin/mocha',
  [
    ...common,
    'lib/scoring-tests.cjs',
    '--grep',
    'TV game playback entry|the replay screen|replay box score|line score|board timeline|scoreboard overlay|board over a single picture'
  ],
  { NODE_V8_COVERAGE: temp }
)
// Unit counters are frozen before any real database/HTTP integration suite runs.
const unitTemp = resolve(report, 'unit-tmp')
cpSync(temp, unitTemp, { recursive: true })
function collect(directory, output) {
  for (const name of readdirSync(directory)) {
    const file = resolve(directory, name)
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
    '--all',
    '--temp-directory',
    directory,
    '--reporter=text',
    '--reporter=json',
    '--reports-dir',
    output,
    '--exclude-after-remap',
    '--include',
    'src/**/*.ts',
    '--include',
    'src/**/*.tsx',
    '--exclude',
    '**/*.test.*',
    '--exclude',
    '**/*.e2e.*',
    '--exclude',
    'src/test/**'
  ])
}
function gate(output, minimum, scope) {
  run('node', [
    'scripts/changed-line-check.cjs',
    '--base',
    base,
    '--coverage',
    resolve(output, 'coverage-final.json'),
    '--report',
    resolve(output, `changed-${minimum}.json`),
    '--min',
    String(minimum),
    '--ext',
    '.ts',
    '--ext',
    '.tsx',
    '--exclude',
    'src/test',
    ...scope
  ])
}
const unitReport = resolve(report, 'unit')
collect(unitTemp, unitReport)
// Pure scoring and client/UI logic have a separate 90% unit gate.
// Database readers and HTTP routes are integration boundaries, covered below.
gate(unitReport, 90, [
  'src/common',
  'src/app',
  'src/server/scoring/historicalStatistics.ts',
  'src/server/openapi.ts'
])
run(
  'node_modules/.bin/mocha',
  [
    ...common,
    'src/server/routes/gameStatistics.test.ts',
    'src/server/routes/scoreboard.test.ts',
    'src/server/routes/lineScore.test.ts',
    'src/server/routes/boxScore.test.ts',
    'src/server/routes/events.test.ts',
    'src/server/scoring/lineTimeline.test.ts',
    'src/server/scoreboard/boardTimeline.test.ts',
    'src/server/stats/replayBoxScoreParity.test.ts'
  ],
  { NODE_V8_COVERAGE: temp }
)
collect(temp, report)
// No production path is excluded from the combined 95% per-file gate.
gate(report, 95, ['src'])
