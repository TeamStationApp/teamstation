import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { transform } from 'sucrase'

const require = createRequire(import.meta.url)
const {
  changedLines,
  executableLines,
  lineReportFromCounts,
  mappedV8LineCounts
} = require('./changed-line-coverage.cjs')
const scope = [
  'cache.native.ts',
  'cache.ts',
  'cacheFiles.ts',
  'cacheStore.ts',
  'cacheUrl.native.ts',
  'cacheUrl.ts',
  'cachingClient.ts'
].map(name => `src/app/sync/${name}`)
// Score only this branch's lines: diff from where it left the base branch.
const base = execFileSync(
  'git',
  ['merge-base', process.argv[2] ?? 'origin/develop', 'HEAD'],
  { encoding: 'utf8' }
).trim()
const reportsDir = resolve('coverage/serverScopedOfflineCache')
const tempDir = resolve(reportsDir, 'tmp')
const result = spawnSync(
  process.execPath,
  [
    'node_modules/c8/bin/c8.js',
    '--all',
    '--exclude-after-remap',
    ...scope.flatMap(path => ['--include', path]),
    '--exclude',
    '**/*.test.*',
    '--reporter=json',
    '--reporter=text',
    `--reports-dir=${reportsDir}`,
    `--temp-directory=${tempDir}`,
    '--clean=true',
    'node_modules/mocha/bin/mocha.js',
    '-r',
    'sucrase/register',
    '--timeout',
    '20000',
    '--exit',
    'src/app/sync/*.test.ts',
    '--ignore',
    '**/*.integration.test.ts'
  ],
  { stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: tempDir } }
)
if (result.status !== 0) process.exit(result.status ?? 1)

// The native bundle's map must describe exactly the sources being measured.
const bundle = readFileSync('lib/cache-native-test.cjs', 'utf8')
const encoded = /sourceMappingURL=data:application\/json;base64,([^\s]+)/.exec(
  bundle
)?.[1]
if (encoded == null) throw new Error('Native cache source map missing')
const map = JSON.parse(Buffer.from(encoded, 'base64').toString())
if (map.sources.some(source => !isAbsolute(source)))
  throw new Error(
    'Native source map paths must be absolute before c8 filtering'
  )
const nativeSources = [
  'src/app/sync/cache.native.ts',
  'src/app/sync/cacheUrl.native.ts'
]
for (const path of nativeSources) {
  const index = map.sources.findIndex(
    source => resolve('lib', source) === resolve(path)
  )
  if (index < 0 || map.sourcesContent[index] !== readFileSync(path, 'utf8'))
    throw new Error(`Native source map does not match ${path}`)
}
const coverage = JSON.parse(
  readFileSync(resolve(reportsDir, 'coverage-final.json'), 'utf8')
)
const native = coverage[resolve('src/app/sync/cache.native.ts')]
if (
  native == null ||
  Object.keys(native.fnMap).length === 0 ||
  Object.keys(native.branchMap).length === 0 ||
  !Object.values(native.f).some(count => count > 0)
)
  throw new Error('Native mapped function and branch counters are missing')
const counts = {}
for (const path of scope) {
  const source = readFileSync(path, 'utf8')
  counts[path] = Object.fromEntries(
    [...executableLines(path, source)].map(line => [line, 0])
  )
}
const changes = changedLines(
  execFileSync('git', ['diff', '--unified=0', base, '--', ...scope], {
    encoding: 'utf8'
  })
)
const newFiles = scope.filter(
  path =>
    spawnSync('git', ['cat-file', '-e', `${base}:${path}`], { stdio: 'ignore' })
      .status !== 0
)
for (const path of newFiles)
  changes[path] = new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((_, index) => index + 1)
  )
// Validate every scored line in every scoped source contributed by the bundle.
// This also prevents a missing native map from inflating a shared Node source.
const bundledScope = [
  ...nativeSources,
  'src/app/sync/cacheFiles.ts',
  'src/app/sync/cacheStore.ts'
]
const required = {}
for (const path of bundledScope) {
  const index = map.sources.indexOf(resolve(path))
  if (index < 0 || map.sourcesContent[index] !== readFileSync(path, 'utf8'))
    throw new Error(`Native source map does not match ${path}`)
  required[resolve(path)] = new Set(
    [...(changes[path] ?? [])].filter(line => counts[path]?.[line] != null)
  )
}
const bundlePath = resolve('lib/cache-native-test.cjs')
const raw = readdirSync(tempDir)
  .filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(readFileSync(resolve(tempDir, name), 'utf8')))
const scripts = raw
  .flatMap(report => report.result ?? [])
  .filter(
    script =>
      script.url === bundlePath || script.url === pathToFileURL(bundlePath).href
  )
const mappedCounts = mappedV8LineCounts(bundle, map, scripts, required)
// Merge actual token-level V8 counts from the native bundle and the Node
// compilation. Converter line spans can inherit an enclosing range's count.
for (const path of scope.filter(path => !nativeSources.includes(path))) {
  const absolute = resolve(path)
  const url = pathToFileURL(absolute).href
  const original = readFileSync(path, 'utf8')
  // Reproduce the installed sucrase/register transform, then require its map
  // and generated lengths to match the metadata recorded by this V8 run.
  const compiled = transform(original, {
    transforms: ['imports', 'typescript'],
    ...JSON.parse(process.env.SUCRASE_OPTIONS ?? '{}'),
    sourceMapOptions: { compiledFilename: absolute },
    filePath: absolute
  })
  const generated = `${compiled.code}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(compiled.sourceMap)).toString('base64')}`
  const nodeScripts = []
  for (const report of raw) {
    for (const script of report.result ?? []) {
      if (script.url !== url) continue
      const recorded = report['source-map-cache']?.[url]
      if (
        recorded?.data?.mappings !== compiled.sourceMap.mappings ||
        JSON.stringify(recorded.lineLengths) !==
          JSON.stringify(generated.split('\n').map(line => line.length)) ||
        script.functions[0]?.ranges[0]?.endOffset !== generated.length
      )
        throw new Error(`Node coverage source does not match ${path}`)
      nodeScripts.push(script)
    }
  }
  const lines = new Set(
    [...(changes[path] ?? [])].filter(line => counts[path]?.[line] != null)
  )
  const measured = mappedV8LineCounts(
    generated,
    { ...compiled.sourceMap, sources: [absolute], sourcesContent: [original] },
    nodeScripts,
    { [absolute]: lines },
    { linePreserving: true }
  )[absolute]
  for (const line of lines)
    measured[line] = Math.max(
      measured[line] ?? 0,
      mappedCounts[absolute]?.[line] ?? 0
    )
  Object.assign(counts[path], measured)
}
for (const path of nativeSources)
  Object.assign(counts[path], mappedCounts[resolve(path)])

for (const minimum of [90, 95]) {
  // Unit counters alone can satisfy the combined gate. No inferred device or
  // integration counters are added to these same-revision measurements.
  const report = lineReportFromCounts(changes, counts, () => true, {
    newFiles,
    min: minimum,
    perFileMin: minimum,
    newFileMin: minimum
  })
  console.log(
    `${minimum === 90 ? 'Unit' : 'Combined (measured unit subset)'} changed executable lines: ${report.covered}/${report.total} (${report.percent.toFixed(2)}%)`
  )
  console.log(JSON.stringify(report, null, 2))
  if (!report.pass) process.exitCode = 1
}
