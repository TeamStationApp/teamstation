import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import gateModule from './observability-line-gate.cjs'
import swift from './swift-changed-line-coverage.cjs'
import counters from './changed-line-coverage.cjs'

const require = createRequire(import.meta.url)
require('sucrase/register')
const { parseBatch } = require('../src/common/observability/contract.ts')
const before = gateModule.snapshot()
const directory = resolve('coverage/observability')
mkdirSync(directory, { recursive: true })
const mode = process.argv[2]
if (!['--swift', '--kotlin'].includes(mode))
  throw new Error('Specify --swift or --kotlin')
const golden = resolve(directory, mode.slice(2) + '-golden.jsonl')
const env = { ...process.env, OBSERVABILITY_GOLDEN_PATH: golden }
const run = (file, args) => {
  console.log('$ ' + [file, ...args].join(' '))
  return execFileSync(file, args, {
    encoding: 'utf8',
    env,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit']
  })
}
let counts = {}
if (mode === '--swift') {
  for (const name of ['TeamStationObservability', 'TeamStationSentryRules']) {
    const raw = swift.spmCounts(resolve('mobile/apps/common', name), run)
    const keyed = Object.fromEntries(
      Object.entries(raw).map(([path, lines]) => [
        relative(before.root, path),
        lines
      ])
    )
    Object.assign(counts, keyed)
    writeFileSync(
      resolve(directory, 'swift-' + name + '.json'),
      JSON.stringify(keyed)
    )
  }
} else {
  console.log(
    run('bash', ['mobile/apps/tsCameramanAndroid/scripts/test-unit.sh'])
  )
  // A separate report invocation guarantees fresh counters after the complete suites.
  console.log(
    run('mobile/apps/tsCameramanAndroid/gradlew', [
      '-p',
      'mobile/apps/tsCameramanAndroid',
      ':app:koverXmlReportDebug',
      ':streamcore:koverXmlReportDebug',
      '--console=plain'
    ])
  )
  for (const dir of [
    'mobile/apps/tsCameramanAndroid/app',
    'mobile/apps/common/android/streamcore'
  ]) {
    const raw = counters.jacocoCounts(
      readFileSync(resolve(dir, 'build/reports/kover/reportDebug.xml'), 'utf8')
    )
    Object.assign(
      counts,
      Object.fromEntries(
        Object.entries(raw).map(([path, lines]) => [
          dir + '/src/main/kotlin/' + path,
          lines
        ])
      )
    )
  }
}
const lines = readFileSync(golden, 'utf8')
const records = parseBatch(lines, Date.parse('2026-01-01T12:00:00.000Z'))
if (
  records.length === 0 ||
  !lines
    .split('\n')
    .filter(Boolean)
    .every(line => line.startsWith('{"D":'))
)
  throw new Error('Native contract fixture failed')
console.log(
  'Native JSONL accepted by shared contract: ' + records.length + ' records'
)
const report = gateModule.gate(before, counts, path =>
  path.endsWith(mode === '--swift' ? '.swift' : '.kt')
)
writeFileSync(
  resolve(directory, mode.slice(2) + '-gate.json'),
  JSON.stringify({ stamp: before.stamp, report }, null, 2)
)
