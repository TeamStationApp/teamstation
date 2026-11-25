// unit runs isolated suites. combined also reads real server and browser counters
// from the tested web build. NODE_V8_COVERAGE directories are integration-v8
// and server-v8 under coverage/ios-app-banner; browser holds E1's Istanbul map.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import lines from './changed-line-coverage.cjs'
import {
  compiledCoverageSource,
  localCoverageMap,
  mappedSourceLines,
  requireCounters,
  requiredLines
} from './ios-app-banner-reports.mjs'
import bannerSource from './ios-app-banner-source.cjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

const browserFiles = [
  'src/app/web/iosAppBanner.ts',
  'src/app/screens/NodeSettingsCard.tsx',
  'src/common/nodeSettings.ts'
]
const files = [
  ...browserFiles,
  'src/server/middleware/withAuth.ts',
  'src/server/db/database.ts',
  'src/server/nodeSettings.ts',
  'src/server/routes/nodeAdministration.ts',
  'src/server/auth/apiKeyFamilies.ts',
  'src/server/openapi.ts',
  'src/build.mjs',
  'src/buildCsp.mjs',
  'src/buildIosAppBanner.mjs'
]
const mode = process.argv[2]
const root = resolve('coverage/ios-app-banner')
mkdirSync(root, { recursive: true })
const { coverageBase, coverageSource } = bannerSource
const source = coverageSource()
function verifySource() {
  if (coverageSource() !== source)
    throw new Error('Source changed during coverage collection')
}
// Before starting an instrumented server or integration suite on any machine,
// stamp its NODE_V8_COVERAGE directory from that machine's source checkout.
if (mode === 'stamp') {
  const dir = process.env.NODE_V8_COVERAGE
  if (!dir)
    throw new Error(
      'Set NODE_V8_COVERAGE to the directory the measured process will use'
    )
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'source.sha256')
  const entries = readdirSync(dir)
  if (entries.length === 0) writeFileSync(path, source, { flag: 'wx' })
  else if (
    !entries.includes('source.sha256') ||
    readFileSync(path, 'utf8') !== source
  )
    throw new Error('Use a fresh coverage directory for this revision')
  process.exit(0)
}
const require = createRequire(import.meta.url)
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const putJson = (path, value) => writeFileSync(path, JSON.stringify(value))
const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status ?? result.signal}`)
}
const pathFor = candidate =>
  files.find(file => candidate === file || candidate.endsWith('/' + file))
const bin = name => resolve('node_modules/.bin', name)

// Bind the release and its source maps to the tree that built them. E1 also
// checks the served bytes against these files before accepting its counters.
if (mode === 'build') {
  run('npm', ['run', 'build.web'])
  verifySource()
  const dir = resolve(process.env.TS_WEB_OUT_DIR ?? 'dist')
  const assets = {}
  for (const file of readdirSync(dir)) {
    if (/^app-(?:ios-app-banner-)?[A-Z0-9]+\.js(?:\.map)?$/.test(file))
      assets[file] = createHash('sha256')
        .update(readFileSync(join(dir, file)))
        .digest('hex')
  }
  putJson(join(dir, 'ios-app-banner-coverage.json'), { source, assets })
  process.exit(0)
}

if (mode !== 'unit' && mode !== 'combined')
  throw new Error('Choose unit or combined')
const base = coverageBase()
const changes = lines.changedLines(
  execFileSync('git', ['diff', '--unified=0', base, '--', ...files], {
    encoding: 'utf8'
  })
)
const requiredLinesByFile = Object.fromEntries(
  files.map(file => [
    file,
    requiredLines(file, readFileSync(file, 'utf8'), changes[file])
  ])
)

// Node stores absolute source URLs even for portable source maps. Remap them
// into this checkout before c8 reads them, verifying source bytes when present.
function reportV8(dir, label, requiredCompiled) {
  const measuredCompiled = new Set()
  const normalized = mkdtempSync(join(root, label + '-normalized-'))
  const totals = mkdtempSync(join(root, label + '-report-'))
  const records = readdirSync(dir).filter(file =>
    /^coverage-.*\.json$/.test(file)
  )
  if (records.length === 0) throw new Error('No V8 counters in ' + dir)
  for (const record of records) {
    const data = readJson(join(dir, record))
    const result = []
    const cache = {}
    for (const entry of data.result) {
      if (!entry.url.startsWith('file:')) continue
      const name = fileURLToPath(entry.url)
      const map = data['source-map-cache']?.[entry.url]
      const compiled = compiledCoverageSource(name, map, pathFor)
      if (compiled) measuredCompiled.add(compiled)
      const original = pathFor(name)
      const mapped = map?.data?.sources ?? []
      if (!original && !mapped.some(pathFor)) continue
      if (
        !entry.functions.some(fn =>
          fn.ranges.some(
            range => Number.isFinite(range.count) && range.count >= 0
          )
        )
      )
        throw new Error('Missing V8 counters for ' + name)
      const typed =
        compiled ?? (original?.endsWith('.ts') ? original : undefined)
      if (typed) {
        const mappedLines =
          map?.data && mappedSourceLines(map.data, pathFor).get(typed)
        for (const line of requiredLinesByFile[typed])
          if (!mappedLines?.has(line))
            throw new Error(`Missing V8 source mapping for ${typed}:${line}`)
      }
      const local = original
        ? resolve(original)
        : join(
            normalized,
            createHash('sha256').update(name).digest('hex').slice(0, 16) +
              '-' +
              basename(name)
          )
      entry.url = pathToFileURL(local).href
      if (map?.data) {
        map.data.sources = mapped.map((url, i) => {
          const file = pathFor(url)
          if (!file) return url.startsWith('file:') ? fileURLToPath(url) : url
          const embedded = map.data.sourcesContent?.[i]
          if (embedded != null && embedded !== readFileSync(file, 'utf8'))
            throw new Error('Stale source map for ' + file)
          return resolve(file)
        })
        cache[entry.url] = map
      }
      result.push(entry)
    }
    if (result.length)
      putJson(join(normalized, record), { result, 'source-map-cache': cache })
  }
  if (requiredCompiled && !measuredCompiled.has(requiredCompiled))
    throw new Error('Missing compiled restart counters for ' + requiredCompiled)
  run(bin('c8'), [
    'report',
    '--temp-directory',
    normalized,
    '--reports-dir',
    totals,
    '--reporter=json',
    '--exclude-after-remap',
    ...files.flatMap(file => ['--include', file])
  ])
  const report = readJson(join(totals, 'coverage-final.json'))
  for (const file of files)
    if (report[resolve(file)])
      requireCounters(report, file, requiredLinesByFile[file])
  return report
}

async function unit() {
  const raw = mkdtempSync(join(root, 'unit-v8-'))
  const bundle = join(root, 'ui.cjs')
  await build({
    ...webSettings,
    plugins: [...webSettings.plugins, pagedListStandInPlugin()],
    stdin: {
      contents: ['NodeSettingsCard', 'NodeAdministrationScreen', 'OAuthScreen']
        .map(name => `import './src/app/screens/${name}.test.tsx'`)
        .join('\n'),
      resolveDir: process.cwd()
    },
    outfile: bundle,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    jsx: 'automatic',
    sourcemap: true,
    external: [
      'react',
      'react-dom',
      'three',
      '@react-three/fiber',
      '@react-three/test-renderer',
      'jsdom',
      'mocha',
      'chai'
    ],
    define: {
      __DEV__: 'true',
      TS_API_BASE_URL: '"/api/v1"',
      'process.env.NODE_ENV': '"test"'
    },
    loader: ASSET_LOADER
  })
  const env = { NODE_V8_COVERAGE: raw }
  run(
    bin('mocha'),
    [
      '--exit',
      '--timeout',
      '60000',
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      bundle,
      'src/common/nodeSettings.test.ts',
      'src/server/openapi.test.ts',
      'src/server/auth/apiKeyFamilies.test.ts',
      'src/server/iosAppBanner.test.ts',
      'src/app/web/iosAppBanner.test.ts'
    ],
    env
  )
  run(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--test',
      'src/buildIosAppBanner.test.mjs'
    ],
    env
  )
  const report = reportV8(raw, 'unit')
  verifySource()
  putJson(join(root, 'unit.json'), { source, report })
  return report
}

function combined() {
  const saved = readJson(join(root, 'unit.json'))
  if (saved.source !== source)
    throw new Error('Unit coverage belongs to another source revision')
  const total = localCoverageMap(saved.report, pathFor)
  for (const file of files)
    requireCounters(total.toJSON(), file, requiredLinesByFile[file])
  for (const [dir, required, requiredCompiled] of [
    [
      'integration-v8',
      'src/build.mjs',
      'src/server/routes/nodeAdministration.ts'
    ],
    ['server-v8', 'src/server/routes/nodeAdministration.ts']
  ]) {
    if (readFileSync(join(root, dir, 'source.sha256'), 'utf8') !== source)
      throw new Error('Mismatched ' + dir + ' source revision')
    const report = reportV8(join(root, dir), dir, requiredCompiled)
    if (!report[resolve(required)])
      throw new Error('Missing measured ' + required + ' in ' + dir)
    total.merge(report)
  }
  const browser = require('istanbul-lib-coverage').createCoverageMap({})
  for (const name of readdirSync(join(root, 'browser')).filter(name =>
    name.endsWith('.json')
  )) {
    const envelope = readJson(join(root, 'browser', name))
    if (envelope.source !== source)
      throw new Error('Browser coverage belongs to another source revision')
    browser.merge(localCoverageMap(envelope.report, pathFor))
  }
  const webDir = resolve(process.env.TS_IOS_BANNER_WEB_DIR ?? 'dist')
  const release = readJson(join(webDir, 'ios-app-banner-coverage.json'))
  if (release.source !== source)
    throw new Error('Mismatched browser release revision')
  const mapped = new Map()
  for (const [name, digest] of Object.entries(release.assets)) {
    if (!/^app-(?:ios-app-banner-)?[A-Z0-9]+\.js\.map$/.test(name)) continue
    const bytes = readFileSync(join(webDir, name))
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new Error('Stale browser release map: ' + name)
    for (const [file, locations] of mappedSourceLines(
      JSON.parse(bytes),
      pathFor
    )) {
      const known = mapped.get(file) ?? new Set()
      for (const line of locations) known.add(line)
      mapped.set(file, known)
    }
  }
  for (const file of browserFiles) {
    if (!mapped.get(file)?.size)
      throw new Error('Missing browser source mappings for ' + file)
    requireCounters(
      browser.toJSON(),
      file,
      [...requiredLinesByFile[file]].filter(line => mapped.get(file).has(line))
    )
  }
  total.merge(browser)
  return total.toJSON()
}

const report = mode === 'unit' ? await unit() : combined()
const output = join(root, mode + '-final.json')
putJson(output, report)
for (const file of files)
  requireCounters(report, file, requiredLinesByFile[file])
run(process.execPath, [
  'scripts/changed-line-check.cjs',
  '--base',
  base,
  '--min',
  mode === 'unit' ? '90' : '95',
  '--coverage',
  output,
  '--ext',
  '.ts',
  '--ext',
  '.tsx',
  '--ext',
  '.mjs',
  ...files
])
