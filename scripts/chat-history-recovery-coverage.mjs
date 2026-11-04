import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { createCoverageMap } = require('istanbul-lib-coverage')
const {
  coverageSource,
  verifyCoverageSource
} = require('./coverage-provenance.cjs')
const digest = value => createHash('sha256').update(value).digest('hex')

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

export function main(mode) {
  if (!['unit', 'combined'].includes(mode))
    throw new Error('Expected unit or combined')
  const base = process.env.TS_COVERAGE_BASE
  if (!base) throw new Error('TS_COVERAGE_BASE is required')
  const cwd = process.cwd()
  const source = coverageSource(cwd, base)
  const dir = resolve(`coverage/chatHistory/${mode}`)
  mkdirSync(dir, { recursive: true })
  const run = (command, args) => {
    console.log(`$ ${command} ${args.map(a => JSON.stringify(a)).join(' ')}`)
    execFileSync(command, args, { stdio: 'inherit' })
  }
  const report = `${dir}/coverage-final.json`
  if (mode === 'unit') {
    // These suites use in-memory stores/doubles, not an HTTP/PostgreSQL fixture.
    const specs = [
      ...globSync('src/app/chat/**/*.test.ts'),
      ...globSync('src/common/chatCrypto/*.test.ts'),
      'src/common/chatHistory.test.ts',
      'src/common/api.test.ts',
      'src/server/chat/historyValidation.test.ts',
      'src/server/serverConfig.test.ts'
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
  } else {
    const artifacts = process.env.TS_CHAT_RECOVERY_ARTIFACTS
    if (!artifacts) throw new Error('TS_CHAT_RECOVERY_ARTIFACTS is required')
    const receipts = JSON.parse(
      readFileSync(resolve(artifacts, 'coverage-receipts.json'), 'utf8')
    )
    for (const kind of ['unit', 'integration', 'browser'])
      if (!receipts.some(r => r.kind === kind))
        throw new Error(`Missing ${kind} coverage`)
    writeFileSync(
      report,
      JSON.stringify(mergeRecoveryCoverage(receipts, source))
    )
  }
  verifyCoverageSource(source, cwd, base)
  writeFileSync(
    `${dir}/receipt.json`,
    JSON.stringify(
      { kind: mode, source, report, sha256: digest(readFileSync(report)) },
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
