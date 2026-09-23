import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const includes = JSON.parse(
  readFileSync('src2/test/scoringCoveragePaths.json', 'utf8')
)
console.log('Scoring coverage includes:', includes.join('\n'))
const temp = resolve('coverage/tmp')
rmSync(temp, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
const test = spawnSync(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '-r',
    './src2/test/scoringDomSetup.cjs',
    '--extension',
    'ts',
    '--spec',
    'src2/**/*.test.ts',
    '--spec',
    'lib/scoring-tests.cjs',
    '--ignore',
    '**/node_modules/**'
  ],
  { stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: temp } }
)
// Node caches multi-source bundle maps as file URLs. c8's exclusion callback
// compares filesystem paths before resolving each source, otherwise marking
// every bundled function covered. Normalize map identifiers, never counters.
for (const file of readdirSync(temp)) {
  const path = resolve(temp, file)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {})) {
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  }
  writeFileSync(path, JSON.stringify(data))
}
const report = spawnSync(
  'node_modules/.bin/c8',
  [
    'report',
    '--all',
    '--reporter=text',
    '--reporter=json-summary',
    '--check-coverage',
    '--lines=90',
    ...includes.flatMap(path => ['--include', path]),
    '--exclude',
    '**/*.test.*',
    '--exclude',
    '**/*.e2e.ts',
    '--exclude',
    'src2/test/**',
    '--exclude-after-remap'
  ],
  { stdio: 'inherit' }
)
process.exitCode = test.status !== 0 ? (test.status ?? 1) : (report.status ?? 1)

const summary = JSON.parse(
  readFileSync('coverage/coverage-summary.json', 'utf8')
)
const screen = summary[resolve('src2/app/screens/GameScreen.tsx')]
if (
  screen == null ||
  screen.functions.total === 0 ||
  Object.keys(summary).length < 2
) {
  console.error(
    'Missing original screen coverage: reject an unmapped bundle report.'
  )
  process.exitCode = 1
}
