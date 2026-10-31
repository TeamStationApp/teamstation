import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformSync } from 'esbuild'

const serverOnly = false
const combinedMinimum = 95
const base = process.env.TS_COVERAGE_BASE
if (base == null) throw new Error('Supply TS_COVERAGE_BASE for the TV commits')
const report = resolve('coverage/tv/combined')
rmSync(report, { recursive: true, force: true })
const temp = resolve(report, 'tmp')
mkdirSync(temp, { recursive: true })
const failedSuites = []
function run(command, args, env = {}, collectFailure = false) {
  console.log('$', command, ...args)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) {
    if (!collectFailure) process.exit(result.status ?? 1)
    failedSuites.push(`${command} ${args.join(' ')}`)
  }
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .split('\n')
  .filter(Boolean)
const runtimeConfig =
  /^appletv\/(index|metro.config|babel.config|react-native.config)\.js$/
const changedPaths = [
  ...new Set([...git(['diff', '--name-only', base]).split('\n'), ...untracked])
]
const nativePaths = [
  'appletv/ios/TeamStationTV/AppDelegate.swift',
  'appletv/ios/TeamStationTV/TVSession.m',
  'appletv/ios/TeamStationTV/TVRemote.m',
  'appletv/ios/TeamStationTV/TVPresentation.m'
].filter(path => changedPaths.includes(path))
const paths = [
  ...new Set([...git(['diff', '--name-only', base]).split('\n'), ...untracked])
].filter(path => {
  if (
    !existsSync(path) ||
    (!/^src\/.+\.tsx?$/.test(path) && !runtimeConfig.test(path)) ||
    /\.(test|e2e|integration|smoke)\./.test(path) ||
    path.startsWith('src/test/') ||
    path === 'src/server/chat/chatTestFixture.ts' ||
    path === 'src/server/dev/chatSeed.ts' ||
    /\.d\.ts$/.test(path)
  )
    return false
  if (serverOnly && path.startsWith('src/app/')) return false
  const { code } = transformSync(readFileSync(path, 'utf8'), {
    loader: path.endsWith('x') ? 'tsx' : 'ts',
    format: 'esm'
  })
  return (
    code.replace(/^\s*(export\s*\{\s*\};?|import\s[^;]*;)\s*$/gm, '').trim() !==
    ''
  )
})
if (!serverOnly) {
  run('node', ['scripts/build-scoring-tests.mjs'])
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
      'lib/scoring-tests.cjs',
      '--grep',
      'TeamStation TV|TV |account|Account|NodeSettingsCard'
    ],
    { NODE_V8_COVERAGE: temp },
    true
  )
}
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
    'src/server/routes/tvLogin.test.ts',
    'src/server/serverStart.test.ts',
    'src/server/routes/videoCollections.test.ts',
    'src/server/routes/teams.test.ts',
    'src/server/routes/users.test.ts',
    'src/server/routes/players.test.ts',
    'src/server/routes/director.test.ts',
    'src/server/routes/scoreboard.test.ts',
    'src/server/routes/highlightRoutes.test.ts',
    'src/app/tv/*.test.ts',
    'src/test/tvBuildConfig.test.ts',
    'src/test/tvNativePresentation.test.ts',
    'src/server/auth/tvLocation.test.ts',
    'src/app/navigation/*.test.ts',
    'src/server/routes/signup.test.ts',
    'src/server/routes/password.test.ts',
    'src/server/routes/appSignIn.test.ts',
    'src/server/routes/appLinks.test.ts',
    'src/server/openapi.test.ts',
    'src/common/api.test.ts',
    'src/common/nodeSettings.test.ts',
    'src/server/nodeSettings.test.ts',
    'src/app/player/multiCam/playerLayout.test.ts',
    'src/app/player/scoreboardOverlay/overlayLayout.test.ts'
  ],
  { NODE_V8_COVERAGE: temp },
  true
)
for (const name of readdirSync(temp)) {
  const file = resolve(temp, name)
  const value = JSON.parse(readFileSync(file, 'utf8'))
  for (const map of Object.values(value['source-map-cache'] ?? {}))
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  writeFileSync(file, JSON.stringify(value))
}
run('node_modules/.bin/c8', [
  'report',
  '--all',
  '--temp-directory',
  temp,
  '--reporter=text',
  '--reporter=json',
  '--reports-dir',
  report,
  '--exclude-after-remap',
  ...paths.flatMap(path => ['--include', path]),
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude',
  'src/test/**'
])
const require = createRequire(import.meta.url)
const map = require('istanbul-lib-coverage').createCoverageMap(
  JSON.parse(readFileSync(resolve(report, 'coverage-final.json'), 'utf8'))
)
mkdirSync(resolve('coverage/tv/unit'), { recursive: true })
writeFileSync(
  resolve('coverage/tv/unit/coverage-final.json'),
  JSON.stringify(map.toJSON())
)
if (process.env.TS_TV_BROWSER_COVERAGE != null)
  map.merge(
    JSON.parse(readFileSync(process.env.TS_TV_BROWSER_COVERAGE, 'utf8'))
  )
writeFileSync(
  resolve(report, 'coverage-final.json'),
  JSON.stringify(map.toJSON())
)
const allPaths = [...paths, ...nativePaths]
let diff = git(['diff', '--unified=0', base, '--', ...allPaths])
for (const path of untracked.filter(path => allPaths.includes(path))) {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
}
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts,
  withoutTypeOnlyLines
} = require('./changed-line-coverage.cjs')
const counts = {}
for (const path of paths)
  if (map.files().includes(resolve(path)))
    counts[path] = withoutTypeOnlyLines(
      path,
      readFileSync(path, 'utf8'),
      istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
    )
const { validateCounts } = require('./llvm-changed-line-counts.cjs')
if (nativePaths.length > 0) {
  const nativeEnvelope = JSON.parse(
    readFileSync('appletv/coverage/native-counts.json', 'utf8')
  )
  Object.assign(counts, validateCounts(nativeEnvelope, process.cwd()))
}
const result = lineReportFromCounts(
  changedLines(diff),
  counts,
  path => allPaths.includes(path),
  { min: combinedMinimum }
)
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify(result, null, 2)
)
const failures = []
for (const [path, lines] of Object.entries(result.files)) {
  const total = lines.covered.length + lines.uncovered.length
  if (total === 0) continue
  const percent = (lines.covered.length / total) * 100
  console.log(
    `${path}: ${percent.toFixed(2)}% (${lines.covered.length}/${total})${lines.uncovered.length ? ' uncovered ' + lines.uncovered.join(',') : ''}`
  )
  if (percent < combinedMinimum) failures.push(path)
}
console.log(
  `TV changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total})`
)
if (failedSuites.length)
  console.error('Test suites failed:', failedSuites.join('\n'))
if (
  failedSuites.length ||
  failures.length ||
  !result.pass ||
  result.total === 0
)
  throw new Error(
    `At least ${combinedMinimum}% combined changed runtime coverage required: ${failures.join(', ')}; missing: ${result.missing.join(', ')}`
  )
