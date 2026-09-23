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

// Keep the whole changed-source aggregate honest as this plan grows.
const changes = spawnSync(
  'git',
  [
    'diff',
    '--name-only',
    '6d383fd876fa9e028b426b297968ee5a6ac09e75',
    '--',
    'src2/app'
  ],
  { encoding: 'utf8' }
)
const untracked = spawnSync(
  'git',
  ['ls-files', '--others', '--exclude-standard', 'src2/app'],
  { encoding: 'utf8' }
)
const paths = new Set(
  (changes.stdout + '\n' + untracked.stdout)
    .trim()
    .split('\n')
    .filter(path => /\.tsx?$/.test(path) && !/\.(test|e2e)\./.test(path))
)
let covered = 0
let total = 0
for (const path of paths) {
  const entry = summary[resolve(path)]
  if (entry == null) {
    // Pure type declarations carry no executable counters.
    const source = readFileSync(path, 'utf8')
    if (source.includes('export function') || source.includes('export const')) {
      console.error('Changed executable source missing from coverage:', path)
      process.exitCode = 1
    }
    continue
  }
  covered += entry.lines.covered
  total += entry.lines.total
}
const changedPercent = total === 0 ? 100 : (100 * covered) / total
console.log(
  `Whole changed-file line coverage: ${changedPercent.toFixed(2)}% (${covered}/${total})`
)
if (changedPercent < 90) process.exitCode = 1
