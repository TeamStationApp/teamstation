import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)
const { changedLines } = require('./changed-line-coverage.cjs')
const {
  auditCoverage,
  digest,
  readCounters,
  swiftTestResult
} = require('./user-id-coverage.cjs')
const { spmCounts } = require('./swift-changed-line-coverage.cjs')
const args = process.argv.slice(2)
const option = name => args[args.indexOf(name) + 1]
if (!args.includes('--base'))
  throw new Error('Supply --base with the pinned integration base')
const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  }).trim()
const base = git('rev-parse', option('--base'))
const head = git('rev-parse', 'HEAD')
const root = process.cwd()
const output = resolve('coverage/userIds')
mkdirSync(output, { recursive: true })
const changes = changedLines(git('diff', '--unified=0', base))
const untracked = git('ls-files', '--others', '--exclude-standard')
  .split('\n')
  .filter(Boolean)
const added = new Set([
  ...git('diff', '--name-only', '--diff-filter=A', base).split('\n'),
  ...untracked
])
for (const file of untracked)
  changes[file] = new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((_, i) => i + 1)
  )
const files = {}
for (const [file, lines] of Object.entries(changes)) {
  if (
    !existsSync(file) ||
    !/^(src|tools|mobile)\//.test(file) ||
    !/\.(tsx?|swift|kt)$/.test(file) ||
    /\.(test|e2e|integration|smoke)\./.test(file) ||
    /(^|\/)(test|tests|Tests|fixtures)\//.test(file) ||
    /Tests?\.(swift|kt)$/.test(file) ||
    /\.d\.ts$/.test(file) ||
    /(^|\/)Package\.swift$/.test(file)
  )
    continue
  if (/\.tsx?$/.test(file)) {
    const { code } = transformSync(readFileSync(file, 'utf8'), {
      loader: file.endsWith('x') ? 'tsx' : 'ts',
      format: 'esm'
    })
    if (
      code
        .replace(/^\s*(export\s*\{\s*\};?|import\s[^;]*;)\s*$/gm, '')
        .trim() === ''
    )
      continue
  }
  files[file] = {
    hash: digest(file),
    lines: [...lines],
    added: added.has(file)
  }
}
const snapshot = { base, head, files }
writeFileSync(
  resolve(output, 'snapshot.json'),
  JSON.stringify(snapshot, null, 2)
)
const run = (command, argv, env = {}, collectFailure = false) => {
  console.log('$', command, ...argv)
  const result = spawnSync(command, argv, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0 && !collectFailure)
    throw new Error(`Coverage command failed (${result.status}): ${command}`)
  return result.status
}
if (!args.includes('--check-only') && !args.includes('--native-only')) {
  const temp = resolve(output, 'tmp')
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  run('node', ['scripts/build-scoring-tests.mjs'])
  const testReport = resolve(output, 'tests.json')
  run(
    'node_modules/.bin/mocha',
    [
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      '--timeout',
      '60000',
      '--exit',
      '--extension',
      'ts',
      '--spec',
      'src/**/*.test.ts',
      '--spec',
      'tools/eventControl/**/*.test.ts',
      '--spec',
      'lib/scoring-tests.cjs',
      '--ignore',
      '**/node_modules/**',
      '--reporter',
      'json',
      '--reporter-option',
      `output=${testReport}`
    ],
    { NODE_V8_COVERAGE: temp },
    true
  )
  for (const name of readdirSync(temp)) {
    const path = resolve(temp, name)
    const data = JSON.parse(readFileSync(path, 'utf8'))
    for (const map of Object.values(data['source-map-cache'] ?? {}))
      if (map.data?.sources != null)
        map.data.sources = map.data.sources.map(source =>
          source.startsWith('file://') ? fileURLToPath(source) : source
        )
    writeFileSync(path, JSON.stringify(data))
  }
  run(
    'node_modules/.bin/c8',
    [
      'report',
      '--reporter=json',
      '--reports-dir',
      output,
      '--exclude',
      '**/*.test.*',
      '--exclude',
      '**/*.e2e.ts',
      '--exclude',
      '**/*.integration.ts',
      '--exclude',
      'src/test/**',
      '--exclude-after-remap'
    ],
    { NODE_V8_COVERAGE: temp }
  )
  const raw = readCounters(
    'istanbul',
    readFileSync(resolve(output, 'coverage-final.json'), 'utf8')
  )
  const counts = Object.fromEntries(
    Object.entries(raw).map(([file, lines]) => [
      isAbsolute(file) ? relative(root, file) : file,
      lines
    ])
  )
  const suite = JSON.parse(readFileSync(testReport, 'utf8'))
  const stats = suite.stats
  if (stats.passes < 1) throw new Error('No passing measured suite')
  for (const [file, source] of Object.entries(files))
    if (digest(file) !== source.hash)
      throw new Error(`Source changed during coverage: ${file}`)
  writeFileSync(
    resolve(output, 'host-report.json'),
    JSON.stringify({
      base,
      head,
      tests: stats.passes,
      failures: suite.failures.map(test => test.fullTitle),
      hashes: Object.fromEntries(
        Object.entries(files).map(([file, value]) => [file, value.hash])
      ),
      counts
    })
  )
}
const nativeFiles = Object.keys(files).filter(file =>
  /\.(swift|kt)$/.test(file)
)
if (!args.includes('--check-only') && nativeFiles.length > 0) {
  const counts = {}
  let tests = 0
  const failures = []
  const addCounts = raw => {
    for (const [file, lines] of Object.entries(raw)) {
      const name = isAbsolute(file) ? relative(root, file) : file
      const destination = (counts[name] ??= {})
      for (const [line, hits] of Object.entries(lines))
        destination[line] = Math.max(destination[line] ?? 0, hits)
    }
  }
  for (const name of ['EventControl', 'TeamStationKit', 'CameramanCore']) {
    const path = `mobile/apps/common/${name}`
    if (!nativeFiles.some(file => file.startsWith(path + '/'))) continue
    let measuredTests = 0
    console.log('$ swift test --enable-code-coverage --package-path', path)
    const log = []
    const raw = spmCounts(
      resolve(path),
      (command, argv) => {
        const result = spawnSync(command, argv, {
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024
        })
        const text = (result.stdout ?? '') + (result.stderr ?? '')
        log.push('$ ' + [command, ...argv].join(' '), text)
        writeFileSync(resolve(output, `${name}.log`), log.join('\n'))
        if (command === 'swift' && argv.includes('--enable-code-coverage')) {
          const measured = swiftTestResult(name, result.status, text)
          measuredTests = measured.tests
          failures.push(...measured.failures)
        } else if (result.status !== 0)
          throw new Error(`${name} host export failed: ${text.slice(-6000)}`)
        return result.stdout ?? ''
      },
      { mergeRawProfiles: true }
    )
    writeFileSync(resolve(output, `${name}.log`), log.join('\n'))
    tests += measuredTests
    addCounts(raw)
  }
  if (nativeFiles.some(file => file.endsWith('.kt'))) {
    const path = resolve('mobile/apps/tsCameramanAndroid')
    console.log('$ ./gradlew JVM unit tests and Kover reports')
    const result = spawnSync(
      './gradlew',
      [
        ':app:testDebugUnitTest',
        ':streamcore:testDebugUnitTest',
        ':app:koverXmlReportDebug',
        ':streamcore:koverXmlReportDebug',
        '--console=plain',
        '--rerun-tasks'
      ],
      {
        cwd: path,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024
      }
    )
    writeFileSync(
      resolve(output, 'jvm.log'),
      (result.stdout ?? '') + (result.stderr ?? '')
    )
    if (result.status !== 0)
      throw new Error('JVM tests/coverage failed; see coverage/userIds/jvm.log')
    for (const module of [
      resolve(path, 'app'),
      resolve(path, '../common/android/streamcore')
    ]) {
      let moduleTests = 0
      for (const file of readdirSync(
        resolve(module, 'build/test-results/testDebugUnitTest')
      )) {
        if (!file.endsWith('.xml')) continue
        const xml = readFileSync(
          resolve(module, 'build/test-results/testDebugUnitTest', file),
          'utf8'
        )
        const attr = name =>
          Number(new RegExp(`\\b${name}="(\\d+)"`).exec(xml)?.[1] ?? 0)
        if (attr('failures') + attr('errors') > 0)
          throw new Error('Failing measured JVM suite')
        moduleTests += attr('tests') - attr('skipped')
      }
      if (moduleTests < 1) throw new Error('No measured JVM tests')
      tests += moduleTests
      const raw = readCounters(
        'jacoco',
        readFileSync(
          resolve(module, 'build/reports/kover/reportDebug.xml'),
          'utf8'
        )
      )
      addCounts(
        Object.fromEntries(
          Object.entries(raw).map(([file, lines]) => [
            relative(root, resolve(module, 'src/main/kotlin', file)),
            lines
          ])
        )
      )
    }
  }
  for (const [file, source] of Object.entries(files))
    if (digest(file) !== source.hash)
      throw new Error(`Source changed during coverage: ${file}`)
  writeFileSync(
    resolve(output, 'native-report.json'),
    JSON.stringify({
      base,
      head,
      tests,
      failures,
      hashes: Object.fromEntries(
        Object.entries(files).map(([file, value]) => [file, value.hash])
      ),
      counts
    })
  )
}
const reportPaths = args.includes('--native-only')
  ? []
  : [resolve(output, 'host-report.json')]
if (nativeFiles.length > 0)
  reportPaths.push(resolve(output, 'native-report.json'))
for (let i = 0; i < args.length; i++)
  if (args[i] === '--report') reportPaths.push(resolve(args[++i]))
const reports = reportPaths.map(path => JSON.parse(readFileSync(path, 'utf8')))
const summary = auditCoverage(
  args.includes('--native-only')
    ? {
        ...snapshot,
        files: Object.fromEntries(nativeFiles.map(file => [file, files[file]]))
      }
    : snapshot,
  reports
)
summary.testFailures = reports.flatMap(report => report.failures ?? [])
writeFileSync(
  resolve(output, 'coverage-summary.json'),
  JSON.stringify(summary, null, 2)
)
console.log(
  JSON.stringify(
    {
      base,
      head,
      covered: summary.covered,
      total: summary.total,
      percent: summary.percent,
      below95: Object.entries(summary.files).filter(
        ([, file]) => file.percent < 95
      ),
      pass: summary.pass
    },
    null,
    2
  )
)
// Preserve coverage evidence even if an independent regression assertion fails.
process.exitCode = summary.pass && summary.testFailures.length === 0 ? 0 : 1
