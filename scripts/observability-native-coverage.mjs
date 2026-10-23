import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'

import counters from './changed-line-coverage.cjs'
import gateModule from './observability-line-gate.cjs'
import swift from './swift-changed-line-coverage.cjs'

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
rmSync(golden, { force: true })
const env = {
  ...process.env,
  OBSERVABILITY_GOLDEN_PATH: golden,
  OBSERVABILITY_SOURCE_STAMP: before.stamp
}
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
  for (const name of [
    'TeamStationObservability',
    'TeamStationSentryRules',
    'TeamStationSentry'
  ]) {
    const raw = swift.spmCounts(resolve('mobile/apps/common', name), run)
    const keyed = Object.fromEntries(
      Object.entries(raw).map(([path, lines]) => [
        relative(before.root, path),
        lines
      ])
    )
    counts = gateModule.mergeCounts(counts, keyed)
    writeFileSync(
      resolve(directory, 'swift-' + name + '.json'),
      JSON.stringify(keyed)
    )
  }
} else {
  // The golden wire file is recreated by tests, so cached tasks are insufficient.
  // Force tests and reports together for fresh fixtures and measured counters.
  console.log(
    run('mobile/apps/tsCameramanAndroid/gradlew', [
      '-p',
      'mobile/apps/tsCameramanAndroid',
      ':app:testDebugUnitTest',
      ':streamcore:testDebugUnitTest',
      ':app:koverXmlReportDebug',
      ':streamcore:koverXmlReportDebug',
      '--rerun-tasks',
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
    counts = gateModule.mergeCounts(
      counts,
      Object.fromEntries(
        Object.entries(raw).map(([path, lines]) => {
          const local = dir + '/src/main/kotlin/' + path
          const shared =
            'mobile/apps/common/android/observability/src/main/kotlin/' + path
          return [existsSync(local) ? local : shared, lines]
        })
      )
    )
  }
}
// Device ownership/signing comes from the run environment. The adapter must run real
// host tests and export fresh measured counters, including the RN startup hooks.
const hostRunner = process.env.OBSERVABILITY_NATIVE_HOST_RUNNER
if (!hostRunner)
  throw new Error('Set OBSERVABILITY_NATIVE_HOST_RUNNER for real host coverage')
const hostOutput = resolve(directory, mode.slice(2) + '-hosts.json')
rmSync(hostOutput, { force: true })
console.log(run(hostRunner, [mode, hostOutput]))
const hosts = JSON.parse(readFileSync(hostOutput, 'utf8'))
gateModule.verifySource(before, hosts)
counts = gateModule.mergeCounts(counts, hosts.counts)
const lines = readFileSync(golden, 'utf8')
// The fixture enumerates every app/kind pair, which can exceed one wire batch.
const records = lines
  .trim()
  .split('\n')
  .flatMap(line => parseBatch(line, Date.parse('2026-01-01T12:00:00.000Z')))
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
