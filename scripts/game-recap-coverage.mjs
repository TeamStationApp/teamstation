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
if (base == null) throw new Error('Supply TS_COVERAGE_BASE')
const report = resolve('coverage/gameRecap')
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
const mocha = [
  '--exit',
  '--timeout',
  '120000',
  '-r',
  'sucrase/register',
  '-r',
  './src/test/scoringDomSetup.cjs'
]
run(
  'node_modules/.bin/mocha',
  [
    ...mocha,
    'src/server/recap/*.test.ts',
    'src/common/observability/errors.test.ts',
    'src/server/tess/sitemap.test.ts',
    'src/server/serverConfig.test.ts',
    'src/server/openapi.test.ts',
    'src/server/highlights.test.ts'
  ],
  { NODE_V8_COVERAGE: temp }
)
const unitTemp = resolve(report, 'unit-tmp')
cpSync(temp, unitTemp, { recursive: true })
function collect(directory, out) {
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
    '--reports-dir',
    out,
    '--reporter=text',
    '--reporter=json',
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
function gate(out, min, scope) {
  run('node', [
    'scripts/changed-line-check.cjs',
    '--base',
    base,
    '--coverage',
    resolve(out, 'coverage-final.json'),
    '--report',
    resolve(out, `changed-${min}.json`),
    '--min',
    String(min),
    '--ext',
    '.ts',
    '--ext',
    '.tsx',
    '--exclude',
    'src/test',
    ...scope
  ])
}
const unit = resolve(report, 'unit')
collect(unitTemp, unit)
gate(unit, 90, [
  'src/common/gameRecap.ts',
  'src/server/recap/model.ts',
  'src/server/recap/clips.ts',
  'src/server/serverConfigSchema.ts',
  'src/server/openapi.ts'
])
run(
  'node_modules/.bin/mocha',
  [
    ...mocha,
    'src/server/routes/recap.test.ts',
    'src/server/socket/syncRevision.test.ts',
    'src/server/events/playEventTimes.test.ts',
    'src/server/events/radarSpeeds.test.ts',
    'src/server/routes/events.test.ts',
    'src/server/routes/lineups.test.ts',
    'src/server/routes/gameStatistics.test.ts',
    'src/server/routes/nonMemberView.test.ts',
    'src/server/serverStart.test.ts',
    'src/migrate/runner.test.ts'
  ],
  { NODE_V8_COVERAGE: temp }
)
collect(temp, report)
gate(report, 95, ['src'])
