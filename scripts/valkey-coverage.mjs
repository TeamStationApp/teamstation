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

// Merge V8 counters from unit and real-boundary tests before reporting lines.
const production = [
  'src/server/valkey/client.ts',
  'src/common/observability/serverCodeFiles.ts',
  'src/server/cache/valkeyCache.ts',
  'src/server/scoreboard/scoreboardStore.ts',
  'src/server/scoreboard/gameSource.ts',
  'src/server/scoreboard/scoreboardHub.ts',
  'src/server/scoreboard/scoreboardScript.ts',
  'src/server/changeFeed/valkeyFeed.ts',
  'src/server/changeFeed/relay.ts',
  'src/server/media/livePlaylists.ts',
  'src/server/ingest/run.ts'
]
const suites = [
  'src/server/valkey/client.integration.test.ts',
  'src/server/teams/rosterCache.integration.test.ts',
  'src/server/scoreboard/scoreboardStore.integration.test.ts',
  'src/server/scoreboard/gameSource.integration.test.ts',
  'src/server/scoreboard/scoreboardHub.integration.test.ts',
  'src/server/changeFeed/valkeyFeed.integration.test.ts',
  'src/server/changeFeed/relay.integration.test.ts',
  'src/server/media/spacesHls.integration.test.ts',
  'src/server/ingest/run.integration.test.ts'
]
const root = resolve('coverage/valkey')
rmSync(root, { recursive: true, force: true })
const unit = resolve(root, 'unit-raw')
const combined = resolve(root, 'combined-raw')
mkdirSync(unit, { recursive: true })
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function test(files, temp) {
  run(
    [
      'node_modules/mocha/bin/mocha.js',
      '--exit',
      '--timeout',
      '60000',
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      ...files
    ],
    { ...process.env, NODE_V8_COVERAGE: temp }
  )
}
function report(temp, dir, files, extra = []) {
  // Sucrase's file URLs must resolve to the same source paths in each tier.
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
  run([
    'node_modules/c8/bin/c8.js',
    'report',
    '--all',
    '--temp-directory',
    temp,
    '--reports-dir',
    dir,
    '--reporter=text',
    '--reporter=json',
    '--reporter=json-summary',
    '--exclude-after-remap',
    ...files.flatMap(file => ['--include', file]),
    ...extra
  ])
}
test(
  [
    'src/server/valkey/client.test.ts',
    'src/common/observability/errors.test.ts'
  ],
  unit
)
report(
  unit,
  resolve(root, 'unit'),
  [production[0]],
  ['--check-coverage', '--per-file', '--lines', '90']
)
cpSync(unit, combined, { recursive: true })
test(suites, combined)
report(combined, resolve(root, 'combined'), production)
run([
  'scripts/changed-line-check.cjs',
  '--base',
  process.env.TS_COVERAGE_BASE ?? 'origin/develop',
  '--min',
  '95',
  '--coverage',
  resolve(root, 'combined/coverage-final.json'),
  '--ext',
  '.ts',
  ...production
])
