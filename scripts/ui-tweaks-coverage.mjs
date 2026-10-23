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
if (base == null)
  throw new Error('Supply TS_COVERAGE_BASE for the UI tweaks commits')
const report = resolve('coverage/uiTweaks')
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
const paths = [
  ...new Set([...git(['diff', '--name-only', base]).split('\n'), ...untracked])
].filter(path => {
  if (
    !existsSync(path) ||
    !/^src\/.+\.tsx?$/.test(path) ||
    /\.(test|e2e|integration|smoke)\./.test(path) ||
    path.startsWith('src/test/') ||
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
      'roster|Roster|scoring sheet|player entry|placeholder|the coach|coach game|the Coach Game pill|automatic and explicit sections|title event creation and event detail editing|game page|game screen|game hero|game sections|game tabs|game watch|game card|relationship list|shared relationship Leave row|confirmed season participation departure|group settings identity|the league page|the season screen|settings people flows|creation and organization interface behavior|settings cleanup shared presentation|calendar, five-minute|timezone city selection|ScheduleRow|team presentation|minimal public team|team schedule|schedule event creation entry|season time|season page|group link|discovery|membership|Membership|warning|Warning|poster|Poster|sign.in|login|Login|event Info|event RSVP|schedule RSVP|recording|streaming screen|actual app|actual App|the app at launch|team route frames|Search tab|non-member|member’s game Videos|team card’s right|expanded statistics|the games feed|direct action app completion|applyCoverCrop|Coach Game|Score Game|the game Record button|Home Add and Create|the home screen|GameHeroCard|game actions|actual game scoring entry|the box score|player’s settings form' +
        '|the person profile|Team roles on Settings|umpire|Umpire|TickerText|native season layout|TextWidthButton|text-width|card content spacing|pill label clearance' +
        '|stack navigator|scene slot|stack transitions|history motion|predictive back'
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
    '--timeout',
    '60000',
    '--exit',
    'src/common/seasonTimeFrames.test.ts',
    'src/common/playerSettings.test.ts',
    'src/common/api.test.ts',
    'src/common/eventInfo.test.ts',
    'src/server/umpires/*.test.ts',
    'src/common/umpireGameDetail.test.ts',
    'src/common/scoring/rosterCommands.test.ts',
    'src/app/navigation/routes.test.ts',
    'src/app/navigation/stackScene.test.ts',
    'src/app/navigation/historyMotion.test.ts',
    'src/app/navigation/history.test.ts',
    'src/app/scoring/createDictatedPlayers.test.ts',
    'src/app/scoring/dictatedRoster.test.ts',
    'src/server/events/eventInfo.test.ts',
    'src/server/games/gameLive.test.ts',
    'src/server/games/scoringActivity.test.ts',
    'src/server/dictation/interpreter.test.ts',
    'src/server/routes/membershipRequests.test.ts',
    'src/server/routes/appSignIn.test.ts',
    'src/server/routes/events.test.ts',
    'src/server/routes/games.test.ts',
    'src/server/routes/people.test.ts',
    'src/server/routes/seasons.test.ts',
    'src/server/routes/seasonReaders.test.ts',
    'src/server/notifications/requestInformation.test.ts',
    'src/app/scoring/playerDraft.test.ts',
    'src/app/scoring/currentSetup.test.ts',
    'src/app/screens/gameTabs.test.ts',
    'src/app/screens/eventTabPolicy.test.ts',
    'src/app/screens/livePillPolicy.test.ts',
    'src/app/layout/watch.test.ts',
    'src/server/live/receiving.test.ts',
    'src/server/openapi.test.ts',
    'src/server/routes/players.test.ts',
    'src/server/routes/lineups.test.ts',
    'src/server/routes/rosterCreation.test.ts',
    'src/server/routes/teamMembers.test.ts',
    'src/server/routes/teams.test.ts',
    'src/server/groups/publicSummary.test.ts',
    ...readdirSync('src/server/routes')
      .filter(name => name === 'publicGameAccess.test.ts')
      .map(name => 'src/server/routes/' + name)
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
if (process.env.TS_DIRECT_BROWSER_COVERAGE != null)
  map.merge(
    JSON.parse(readFileSync(process.env.TS_DIRECT_BROWSER_COVERAGE, 'utf8'))
  )
writeFileSync(
  resolve(report, 'coverage-final.json'),
  JSON.stringify(map.toJSON())
)
let diff = git(['diff', '--unified=0', base, '--', ...paths])
for (const path of untracked.filter(path => paths.includes(path))) {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`
}
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
const counts = {}
for (const path of paths)
  if (map.files().includes(resolve(path)))
    counts[path] = istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
const result = lineReportFromCounts(
  changedLines(diff),
  counts,
  path => paths.includes(path),
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
  `UI tweaks changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total})`
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
