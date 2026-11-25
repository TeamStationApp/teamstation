// --unit runs the focused unit gate. The combined gate also consumes the
// browser coverage map from the same checkout and runs the real HTTP tests.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import {
  changedLines,
  executableLines,
  lineReportFromCounts
} from './changed-line-coverage.cjs'
import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { coverageSource } from './coverage-source.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'
import {
  measuredMappedLines,
  nodeCoverageSource
} from './webPasswordLinkMappedCoverage.mjs'

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
  stdin: {
    contents:
      "import './src/app/web/index.test.tsx'; import './src/app/App.offlineSession.test.tsx'; import './src/app/scoreboard/ScoreboardOverrideScreen.test.tsx'; import './src/app/App.offlineBanner.test.tsx'",
    resolveDir: process.cwd()
  },
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
  'src/app/sync/cachingClient.test.ts',
  'src/app/web/bootstrap.test.ts',
  'src/app/web/passwordLinkBuild.test.ts',
  'src/common/passwordClient.test.ts',
  'src/common/api.test.ts',
  'src/common/api.userManagement.test.ts',
  'src/common/api.tess.test.ts',
  'src/app/platform/passwordKdf.test.ts',
  'src/common/sentry/sentry.test.ts',
  'src/server/routes/passwordLink.test.ts',
  'src/server/openapi.test.ts',
  'src/test/changedLineCoverage.test.ts'
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
const required = Object.fromEntries(
  Object.entries(scope).map(([file, lines]) => [
    resolve(file),
    new Set(
      [...executableLines(file, readFileSync(file, 'utf8'))].filter(line =>
        lines.has(line)
      )
    )
  ])
)
function addCounts(total, additions) {
  for (const [path, lines] of Object.entries(additions)) {
    const counts = (total[path] ??= {})
    for (const [line, hits] of Object.entries(lines))
      counts[line] = (counts[line] ?? 0) + hits
  }
}

function nodeCounts() {
  const counts = {}
  for (const file of readdirSync(temp)) {
    const raw = JSON.parse(readFileSync(resolve(temp, file), 'utf8'))
    for (const script of raw.result) {
      if (!script.url.startsWith('file://')) continue
      const path = fileURLToPath(script.url)
      if (path !== resolve(bundle) && !(path in required)) continue
      const recorded = raw['source-map-cache']?.[script.url]
      if (recorded?.data) {
        const map = recorded.data
        map.sources = map.sources.map(source =>
          source.startsWith('file://')
            ? fileURLToPath(source)
            : resolve(dirname(path), source)
        )
        addCounts(
          counts,
          measuredMappedLines(
            map,
            path === resolve(bundle)
              ? readFileSync(path, 'utf8')
              : nodeCoverageSource(path, recorded),
            [script],
            required,
            { linePreserving: path !== resolve(bundle) }
          )
        )
      } else if (path.endsWith('.mjs')) {
        // The module was run directly by Node, with no transpilation.
        const source = readFileSync(path, 'utf8')
        const lines = source.split('\n')
        const map = {
          version: 3,
          sources: [path],
          sourcesContent: [source],
          names: [],
          mappings: lines.map((line, index) => [
            [Math.max(0, line.search(/\S/)), 0, index, 0]
          ])
        }
        addCounts(
          counts,
          measuredMappedLines(map, source, [script], required, {
            linePreserving: true
          })
        )
      }
    }
  }
  return counts
}
function check(label, maps, minimum) {
  const combined = {}
  for (const map of maps) addCounts(combined, map)
  const counts = Object.fromEntries(
    Object.entries(combined).map(([file, lines]) => [
      relative(process.cwd(), file),
      lines
    ])
  )
  for (const [file, byLine] of Object.entries(counts)) {
    const required = executableLines(file, readFileSync(file, 'utf8'))
    const changed = [...required].filter(line => scope[file].has(line))
    const missing = changed.filter(line => !(line in byLine))
    if (label === 'combined' && missing.length > 0)
      throw Error(
        `Missing coverage mappings in ${file} at lines ${missing.join(', ')}`
      )
    counts[file] = Object.fromEntries(
      changed.map(line => [line, byLine[line] ?? 0])
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
execFileSync(
  process.execPath,
  ['--test', 'scripts/webPasswordLinkMappedCoverage.test.mjs'],
  { stdio: 'inherit' }
)
const unitPass = check('unit', [nodeCounts()], 90)
let combinedPass = true
if (!unitOnly) {
  if (git('status', '--porcelain') !== '')
    throw Error('Use a clean checkout when combining coverage from a web build')
  const revision = git('rev-parse', 'HEAD')
  const verifiedBundle = path => {
    const content = readFileSync(path, 'utf8')
    if (!content.startsWith(`/*! teamstation-web-revision: ${revision} */\n`))
      throw Error('The web build revision differs from the measuring checkout')
    return content
  }
  let browser = process.env.TS_WEB_LINK_BROWSER_COVERAGE
  const dirArg = process.argv.indexOf('--web-dir')
  const webDir = resolve(
    dirArg === -1
      ? (process.env.TS_WEB_LINK_WEB_DIR ?? 'dist')
      : process.argv[dirArg + 1]
  )
  const seatArg = process.argv.indexOf('--seat')
  if (seatArg !== -1) {
    const seat = process.argv[seatArg + 1]
    if (!seat || seat.startsWith('-'))
      throw Error('Supply a configured development seat name')
    const parts = resolve(report, 'browser-parts')
    browser = resolve(report, 'browser.json')
    const e2e = (...args) =>
      execFileSync('npm', ['run', '-s', 'e2e', '--', ...args], {
        stdio: 'inherit'
      })
    // Compare source content as well as the hashed bundle recorded by Chrome.
    // A map from a different checkout may have the same filenames and lines.
    const maps = readdirSync(webDir).filter(name =>
      /^app-[A-Z0-9]+\.js\.map$/.test(name)
    )
    if (maps.length !== 1)
      throw Error('Supply one development web build with its source map')
    const mapPath = resolve(webDir, maps[0])
    verifiedBundle(mapPath.slice(0, -4))
    const map = JSON.parse(readFileSync(mapPath, 'utf8'))
    for (const file of Object.keys(scope)) {
      const index = map.sources.findIndex(name => name.endsWith('/' + file))
      if (
        index !== -1 &&
        map.sourcesContent[index] !== readFileSync(file, 'utf8')
      )
        throw Error('The web source map differs from the checkout: ' + file)
    }
    e2e(
      'run',
      'account/sign-in/password-link#confirm-account-switch',
      '--surface',
      'web-chromium',
      '--seat',
      seat,
      '--browser-coverage',
      parts,
      '--browser-coverage-web-dir',
      dirname(mapPath)
    )
    e2e('coverage-merge', parts, '--out', browser)
    if (source !== coverageSource())
      throw Error('Source changed during the browser run')
    writeFileSync(browser + '.source', source + '\n')
  }
  if (!browser || readFileSync(browser + '.source', 'utf8').trim() !== source)
    throw Error('Supply browser coverage and its matching .source stamp')
  const raw = JSON.parse(readFileSync(browser + '.v8', 'utf8'))
  const browserCounts = {}
  for (const asset of new Set(raw.map(script => script.asset))) {
    if (asset !== basename(asset) || !/^app-[A-Z0-9]+\.js$/.test(asset))
      throw Error('Invalid browser bundle name')
    const path = resolve(webDir, asset)
    const source = verifiedBundle(path)
    const scripts = raw.filter(script => script.asset === asset)
    const hash = createHash('sha256').update(source).digest('hex')
    if (scripts.some(script => script.sha256 !== hash))
      throw Error('Browser bundle differs from recorded V8 ranges')
    const map = JSON.parse(readFileSync(path + '.map', 'utf8'))
    map.sources = map.sources.map(file => resolve(webDir, file))
    for (const [index, file] of map.sources.entries())
      if (
        required[file] &&
        map.sourcesContent[index] !== readFileSync(file, 'utf8')
      )
        throw Error('The web source map differs from the checkout: ' + file)
    const counts = measuredMappedLines(map, source, scripts, required)
    addCounts(browserCounts, counts)
  }
  for (const file of [
    'src/app/web/index.tsx',
    'src/app/web/passwordLogin.ts',
    'src/app/web/render.tsx'
  ]) {
    if (
      !Object.values(browserCounts[resolve(file)] ?? {}).some(hits => hits > 0)
    )
      throw Error('Missing mapped browser execution of ' + file)
  }
  mocha([
    'src/server/routes/password.integration.test.ts',
    'src/server/routes/account.integration.test.ts'
  ])
  mocha([
    'src/server/scoreboard/scoreboardHub.integration.test.ts',
    '--grep',
    'refuses a publisher who is not signed in'
  ])
  combinedPass = check('combined', [nodeCounts(), browserCounts], 95)
}
if (source !== coverageSource())
  throw Error('Source changed while measuring coverage')
if (!unitPass || !combinedPass) process.exitCode = 1
