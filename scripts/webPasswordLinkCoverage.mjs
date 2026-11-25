// --unit runs the focused unit gate. The combined gate also consumes the
// browser coverage map from the same checkout and runs the real HTTP tests.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import {
  changedLines,
  executableLines,
  istanbulCounts,
  lineReportFromCounts
} from './changed-line-coverage.cjs'
import { coverageSource } from './coverage-source.mjs'
import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

const unitOnly = process.argv.includes('--unit')
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8' }).trimEnd()
const base =
  process.env.TS_COVERAGE_BASE ?? git('merge-base', 'HEAD', 'origin/develop')
const source = coverageSource()
const report = resolve('coverage/webPasswordLink')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
mkdirSync('lib', { recursive: true })
const bundle = 'lib/web-password-link-tests.cjs'
await build({
  ...webSettings,
  plugins: [
    ...webSettings.plugins,
    chatCoreResolvePlugin(),
    pagedListStandInPlugin()
  ],
  entryPoints: ['src/app/web/index.test.tsx'],
  outfile: bundle,
  platform: 'node',
  format: 'cjs',
  bundle: true,
  jsx: 'automatic',
  external: [
    'react',
    'react-dom',
    'three',
    '@react-three/fiber',
    '@react-three/test-renderer',
    'jsdom',
    'mocha',
    'chai',
    '@sqlite.org/sqlite-wasm'
  ],
  sourcemap: true,
  loader: ASSET_LOADER,
  define: {
    __DEV__: 'true',
    TS_CHAT_NODE_ADDON: JSON.stringify(
      resolve('src/common/chatCrypto/node/chat_crypto.node')
    ),
    TS_SCHEDULER_NODE_ADDON: JSON.stringify(
      resolve('src/common/scheduler/node/scheduler.node')
    ),
    'process.env.NODE_ENV': '"test"',
    TS_API_BASE_URL: '"/api/v1"'
  }
})
const env = { ...process.env, NODE_V8_COVERAGE: temp }
function mocha(suites) {
  execFileSync(
    'node_modules/.bin/mocha',
    [
      '--timeout',
      '60000',
      '--exit',
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      ...suites
    ],
    { env, stdio: 'inherit' }
  )
}
mocha([
  bundle,
  'src/app/web/passwordLogin.test.ts',
  'src/app/web/bootstrap.test.ts',
  'src/app/web/passwordLinkBuild.test.ts',
  'src/common/passwordClient.test.ts',
  'src/app/platform/passwordKdf.test.ts',
  'src/common/sentry/sentry.test.ts',
  'src/server/routes/passwordLink.test.ts',
  'src/server/openapi.test.ts'
])
const changes = changedLines(git('diff', '--no-renames', '--unified=0', base))
const newFiles = [
  ...git('diff', '--no-renames', '--name-only', '--diff-filter=A', base).split(
    '\n'
  ),
  ...git('ls-files', '--others', '--exclude-standard').split('\n')
].filter(Boolean)
function production(file) {
  return (
    existsSync(file) &&
    (/^src\/.+\.(tsx?|mjs)$/.test(file) ||
      file === 'scripts/web-build-settings.mjs') &&
    !file.startsWith('src/test/') &&
    !/\.(test|spec|e2e)\./.test(file)
  )
}
for (const file of newFiles.filter(production))
  changes[file] = executableLines(file, readFileSync(file, 'utf8'))
const scope = Object.fromEntries(
  Object.entries(changes).filter(([file]) => production(file))
)
function readCounters(label) {
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
  const dir = resolve(report, label)
  execFileSync(
    'node_modules/.bin/c8',
    [
      'report',
      '--temp-directory',
      temp,
      '--reports-dir',
      dir,
      '--reporter=json',
      '--exclude-after-remap',
      ...[...Object.keys(scope), bundle].flatMap(file => ['--include', file])
    ],
    { stdio: 'inherit' }
  )
  return JSON.parse(readFileSync(resolve(dir, 'coverage-final.json'), 'utf8'))
}
function check(label, maps, minimum) {
  const counts = {}
  for (const map of maps)
    for (const [path, entry] of Object.entries(map)) {
      const file = relative(process.cwd(), resolve(path))
      if (!(file in scope)) continue
      const byLine = (counts[file] ??= {})
      for (const [line, hits] of Object.entries(istanbulCounts(entry)))
        byLine[line] = (byLine[line] ?? 0) + hits
    }
  for (const [file, byLine] of Object.entries(counts)) {
    const required = executableLines(file, readFileSync(file, 'utf8'))
    counts[file] = Object.fromEntries(
      Array.from(required, line => [line, byLine[line] ?? 0])
    )
  }
  const result = lineReportFromCounts(scope, counts, () => true, {
    newFiles: newFiles.filter(production),
    newFileMin: minimum,
    perFileMin: minimum,
    min: minimum
  })
  writeFileSync(
    resolve(report, label + '.json'),
    JSON.stringify({ base, source, ...result }, null, 2)
  )
  console.log(
    `${label} ${result.covered}/${result.total} changed executable lines (${result.percent.toFixed(2)}%)`
  )
  if (!result.pass)
    console.error(
      'Coverage below threshold:',
      [
        ...new Set([
          ...result.missing,
          ...result.shortFiles,
          ...result.shortNewFiles
        ])
      ].join(', ')
    )
  return result.pass
}
const unitPass = check('unit', [readCounters('unit-counters')], 90)
let combinedPass = true
if (!unitOnly) {
  const browser = process.env.TS_WEB_LINK_BROWSER_COVERAGE
  if (!browser || readFileSync(browser + '.source', 'utf8').trim() !== source)
    throw Error('Supply browser coverage and its matching .source stamp')
  const browserMap = JSON.parse(readFileSync(browser, 'utf8'))
  for (const file of [
    'src/app/web/index.tsx',
    'src/app/web/passwordLogin.ts',
    'src/app/web/render.tsx'
  ]) {
    const entry = browserMap[resolve(file)] ?? browserMap[file]
    if (!entry || !Object.values(entry.s).some(value => value > 0))
      throw Error('Missing browser execution of ' + file)
  }
  mocha([
    'src/server/routes/password.integration.test.ts',
    'src/server/routes/account.integration.test.ts'
  ])
  combinedPass = check(
    'combined',
    [readCounters('combined-counters'), browserMap],
    95
  )
}
if (source !== coverageSource())
  throw Error('Source changed while measuring coverage')
if (!unitPass || !combinedPass) process.exitCode = 1
