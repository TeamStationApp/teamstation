import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { createCoverageMap } = require('istanbul-lib-coverage')
const {
  coverageSource,
  verifyCoverageSource
} = require('./coverage-provenance.cjs')
const digest = value => createHash('sha256').update(value).digest('hex')

/** Sucrase emits file URLs; Istanbul needs filesystem paths when remapping. */
export function normalizeCoverageSources(data) {
  for (const map of Object.values(data['source-map-cache'] ?? {})) {
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  }
  return data
}

/** Merge measured counters only when source, maps and report bytes match. */
export function mergeRecoveryCoverage(
  receipts,
  source,
  read = path => readFileSync(path)
) {
  if (receipts.length === 0) throw new Error('No measured coverage reports')
  const merged = createCoverageMap({})
  for (const receipt of receipts) {
    if (JSON.stringify(receipt.source) !== JSON.stringify(source))
      throw new Error('Stale or mixed coverage source')
    const bytes = read(receipt.report)
    if (digest(bytes) !== receipt.sha256)
      throw new Error('Coverage report hash mismatch')
    const report = JSON.parse(String(bytes))
    if (Object.keys(report).length === 0)
      throw new Error('Missing instrumentation')
    for (const [path, file] of Object.entries(report)) {
      if (
        file.path !== path ||
        file.statementMap == null ||
        file.s == null ||
        Object.keys(file.statementMap).length === 0
      )
        throw new Error('Missing source maps or counters')
      if (
        /\.(?:cjs|js)$/.test(path) &&
        /(?:coverage|dist|bundle|lib)\//.test(path)
      )
        throw new Error('Coverage must be remapped to original source')
    }
    merged.merge(report)
  }
  return merged.toJSON()
}

export function main(mode, io = {}) {
  const env = io.env ?? process.env
  const sourceFor = io.sourceFor ?? coverageSource
  const verifySource = io.verifySource ?? verifyCoverageSource
  const mkdir = io.mkdir ?? mkdirSync
  const read = io.read ?? readFileSync
  const write = io.write ?? writeFileSync
  const glob = io.glob ?? globSync
  if (!['unit', 'combined'].includes(mode))
    throw new Error('Expected unit or combined')
  const base = env.TS_COVERAGE_BASE
  if (!base) throw new Error('TS_COVERAGE_BASE is required')
  const cwd = process.cwd()
  const source = sourceFor(cwd, base)
  const dir = resolve(`coverage/chatHistory/${mode}`)
  mkdir(dir, { recursive: true })
  const run =
    io.run ??
    ((command, args) => {
      console.log(`$ ${command} ${args.map(a => JSON.stringify(a)).join(' ')}`)
      execFileSync(command, args, { stdio: 'inherit' })
    })
  const report = `${dir}/coverage-final.json`
  if (mode === 'unit') {
    run(process.execPath, [
      'scripts/chat-history-recovery-test-bundle.mjs',
      dir
    ])
    // These suites use in-memory stores/doubles, not an HTTP/PostgreSQL fixture.
    const specs = [
      ...glob('src/app/chat/**/*.test.ts'),
      ...glob('src/common/chatCrypto/*.test.ts'),
      'src/common/chatHistory.test.ts',
      'src/common/api.test.ts',
      'src/server/chat/historyValidation.test.ts',
      'src/server/chat/historyPolicy.test.ts',
      'src/server/routes/chatHistoryPolicy.test.ts',
      'src/server/openapi.test.ts',
      'src/server/chatHistoryWiring.test.ts',
      'src/server/serverConfig.test.ts',
      'src/test/chatRecoveryControl.integration.test.ts',
      'src/test/chatRecoveryFaults.test.ts',
      'src/test/chatRecoveryFixtureContract.integration.test.ts',
      `${dir}/tests.cjs`
    ]
    run(process.execPath, [
      'node_modules/c8/bin/c8.js',
      '--reporter=json',
      '--reporter=text',
      '--reports-dir',
      dir,
      '--temp-directory',
      `${dir}/tmp`,
      '--exclude',
      '**/*.test.*',
      '--exclude-after-remap',
      '--',
      'node_modules/.bin/mocha',
      '--exit',
      '--timeout',
      '120000',
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      ...specs
    ])
    run(process.execPath, [
      'node_modules/c8/bin/c8.js',
      '--clean=false',
      '--reporter=json',
      '--reporter=text',
      '--reports-dir',
      dir,
      '--temp-directory',
      `${dir}/tmp`,
      '--exclude',
      '**/*.test.*',
      '--exclude-after-remap',
      '--',
      process.execPath,
      '--test',
      'scripts/chat-history-recovery-coverage.test.mjs'
    ])
    for (const path of glob(`${dir}/tmp/*.json`)) {
      const data = normalizeCoverageSources(JSON.parse(read(path, 'utf8')))
      write(path, JSON.stringify(data))
    }
    run(process.execPath, [
      'node_modules/c8/bin/c8.js',
      'report',
      '--reporter=json',
      '--reporter=text',
      '--reports-dir',
      dir,
      '--temp-directory',
      `${dir}/tmp`,
      '--exclude',
      '**/*.test.*',
      '--exclude-after-remap'
    ])
  } else {
    const artifacts = env.TS_CHAT_RECOVERY_ARTIFACTS
    if (!artifacts) throw new Error('TS_CHAT_RECOVERY_ARTIFACTS is required')
    const receipts = JSON.parse(
      read(resolve(artifacts, 'coverage-receipts.json'), 'utf8')
    )
    for (const kind of ['unit', 'integration', 'browser'])
      if (!receipts.some(r => r.kind === kind))
        throw new Error(`Missing ${kind} coverage`)
    write(report, JSON.stringify(mergeRecoveryCoverage(receipts, source, read)))
  }
  verifySource(source, cwd, base)
  write(
    `${dir}/receipt.json`,
    JSON.stringify(
      { kind: mode, source, report, sha256: digest(read(report)) },
      null,
      2
    )
  )
  run(process.execPath, [
    'scripts/changed-line-check.cjs',
    '--base',
    base,
    '--coverage',
    report,
    '--report',
    `${dir}/changed-lines.json`,
    '--min',
    mode === 'unit' ? '90' : '95',
    '--ext',
    '.ts',
    '--ext',
    '.tsx',
    '--ext',
    '.mjs',
    '--ext',
    '.cjs',
    '--exclude',
    'src/server/chat/chatTestFixture.ts',
    '--exclude',
    'src/test',
    ...(mode === 'unit' ? ['--exclude', 'src/migrate/migrations'] : []),
    'src',
    'scripts/chat-history-recovery-coverage.mjs'
  ])
}
if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv[2])
