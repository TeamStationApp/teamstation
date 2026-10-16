// The coverage gate for the scoreboard event log and the wall-clock
// scoreboard overlay: every changed runtime line of `src/**/*.ts(x)` since
// TS_COVERAGE_BASE, at 90% or better for each file and in total.
//
//   TS_COVERAGE_BASE=$(git merge-base origin/master HEAD) npm run coverage.scoreboardEventLog
//
// The server suites are every `src/**/*.test.ts`, after the server build
// (`npm run build`) that the OAuth suite starts. The app suites are the
// `.test.tsx` files in `appSuites` below, each bundled and run on its own:
// bundled together they interfere with each other, the way `npm test`'s one
// bundle does. A milestone that changes app code adds the suites that cover
// it to `appSuites`. The web bundle never resolves a `.native.tsx` file, so a
// native component is measured by a suite that imports its `.native` path.
//
// Tests, `src/test`, `src/migrate` (migrations are proved by their own tests),
// `src/server/dev` (development seed scripts, which no suite loads) and
// `database.ts` (types) are not measured.
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import ts from 'typescript'

import { webSettings } from './web-build-settings.mjs'

/** The app suites, each bundled alone. Later milestones append theirs. */
const appSuites = [
  // The scoring screen keeps the server's clock while it is open.
  'src/app/scoring/scoringSession.test.tsx',
  // The override dashboard letters its board in the carried Inter.
  'src/app/scoreboard/dashboardTheme.test.tsx',
  // The node settings a node administrator edits, on the wheel the time
  // picker shares.
  'src/app/screens/NodeSettingsCard.test.tsx',
  // The node administration screen around it, which holds its accounts
  // until the settings have come.
  'src/app/screens/NodeAdministrationScreen.test.tsx',
  'src/app/components/Wheel.test.tsx',
  // The dialog both date pickers open in, clear of the keyboard.
  'src/app/components/PickerDialog.test.tsx'
]

/**
 * Tests that fail on master at the branch's base, whatever this branch does,
 * by their full titles: the layering test names two `scoring*.e2e.ts` files
 * already on master, the DJ Game test reads a key `App.tsx` no longer
 * writes, and nine invitation and pending-schedule tests fail on master as
 * of fae9195d6; the app-title, team-identity, game-proposal and guest-approval
 * tests below them fail on master as of 3a50bc7f8. They are left out so the
 * gate measures this branch; anything else that fails still fails it. Remove
 * a line once master passes it.
 */
const failingOnMaster = [
  'scoring layering holds on the tree and fails on a bad import either way',
  'DJ Game in the shell mounts DJ Game and scoring afresh for each game',
  'proved imported email invitation eligibility retains an imported identity and verifies its address through code, which applies the invitation waiting for it',
  'proved imported email invitation eligibility retains an imported identity and verifies its address through link, which applies the invitation waiting for it',
  'proved imported email invitation eligibility retains an imported identity and verifies its address through invitation, which applies the invitation waiting for it',
  'personal group invitations and accepted role grants offers requested roles to an existing member and restores a consumed link only for its accepted recipient',
  'replacement schedule participant visibility keeps a removed team on its canceled original while proposed participants and the host see the new pending game',
  'replacement schedule participant visibility keeps a managed original matchup pending for its original teams until acceptance updates that same ID',
  'event metadata through game consent and revisions projects supplied details before consent and preserves them through publication and exact retry',
  'scoped pending schedules and request-local authority does not select or authorize twenty unrelated requests for scoped, global-owned, public, or published-only reads',
  'scoped pending schedules and request-local authority annotates retained rows for their published teams but never projects a replacement for its removed opponent',
  'app titles hands the game card up as the card itself goes under',
  'team identity composition boundaries screens/LeaguePage.tsx uses its explicit team identity boundary',
  'team identity composition boundaries screens/SeasonPresentation.tsx uses its explicit team identity boundary',
  'api client retains reserved and replacement identities across game proposal responses',
  'game approval readiness matches Express route semantics preserves case-insensitive routing after cutover, requires the true guest administrator and shares the resulting game'
]
/**
 * `.test.ts` suites master runs only in an esbuild bundle, never under plain
 * mocha: they import React Native components, which mocha cannot load
 * unbundled. Master's own bundle runs them, so the gate leaves them out.
 */
const bundledOnMaster = ['src/app/screens/eventAttendance.test.ts']
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error('Set TS_COVERAGE_BASE to the reviewed parent commit')
const report = resolve('coverage/scoreboardEventLog')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
const bundles = resolve('lib/scoreboardEventLog-tests')
rmSync(bundles, { recursive: true, force: true })
mkdirSync(bundles, { recursive: true })

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}
const lines = text => text.split('\n').filter(line => line !== '')

// Type declarations and forwarding exports have no executable source lines.
function hasExecutableSource(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  return source.statements.some(
    statement =>
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isExportDeclaration(statement) &&
      !(
        ts.isImportDeclaration(statement) &&
        statement.importClause?.isTypeOnly === true
      )
  )
}
const eligible = path =>
  /^src\/.+\.tsx?$/.test(path) &&
  !/\.(test|e2e)\./.test(path) &&
  !path.startsWith('src/test/') &&
  !path.startsWith('src/migrate/') &&
  !path.startsWith('src/server/dev/') &&
  path !== 'src/server/db/database.ts' &&
  hasExecutableSource(path)

const changed = lines(git(['diff', '--name-only', '--diff-filter=d', base]))
const untracked = lines(git(['ls-files', '--others', '--exclude-standard']))
const paths = [...new Set([...changed, ...untracked])].filter(eligible).sort()
if (paths.length === 0) throw new Error('No changed runtime files to measure')

for (const [index, suite] of appSuites.entries()) {
  await build({
    ...webSettings,
    alias: {
      ...webSettings.alias,
      '@react-native/assets-registry/registry':
        'react-native-web/dist/modules/AssetRegistry'
    },
    stdin: {
      contents: `import './${suite}'`,
      resolveDir: process.cwd(),
      sourcefile: `scoreboard-test-${index}.ts`
    },
    outfile: resolve(bundles, `${index}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: true,
    jsx: 'automatic',
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
      TS_API_BASE_URL: JSON.stringify('/api/v1'),
      'process.env.TS_SENTRY_DSN': JSON.stringify(''),
      'process.env.NODE_ENV': JSON.stringify('test')
    },
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
  })
}

run('node', ['src/migrate/requirePostgres18.js'])
// The OAuth suite starts the compiled server from lib/server as well as the
// source one.
if (process.env.npm_execpath != null)
  run(process.execPath, [process.env.npm_execpath, 'run', 'build'])
else run('npm', ['run', 'build'])
const mocha = [
  'node_modules/.bin/mocha',
  ['-r', 'sucrase/register', '-r', './src/test/scoringDomSetup.cjs'],
  ['--timeout', '60000']
]
run(
  mocha[0],
  [
    ...mocha[1],
    ...mocha[2],
    '--extension',
    'ts',
    '--spec',
    'src/**/*.test.ts',
    '--ignore',
    '**/node_modules/**',
    ...bundledOnMaster.flatMap(path => ['--ignore', path]),
    '--grep',
    `^(${failingOnMaster.map(escape).join('|')})$`,
    '--invert'
  ],
  { NODE_V8_COVERAGE: temp }
)
for (const [index, suite] of appSuites.entries()) {
  console.log(`\n${suite}`)
  run(mocha[0], [...mocha[1], ...mocha[2], resolve(bundles, `${index}.cjs`)], {
    NODE_V8_COVERAGE: temp
  })
}

// Bundled sources are file URLs in the recorded source maps; c8 wants paths.
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
run('node_modules/.bin/c8', [
  'report',
  '--temp-directory',
  temp,
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
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
let diff = git(['diff', '--unified=0', base, '--', ...paths])
for (const path of untracked.filter(path => paths.includes(path))) {
  const source = readFileSync(path, 'utf8').split('\n')
  const count = source.length - 1
  diff += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${count} @@\n`
  diff +=
    source
      .slice(0, count)
      .map(line => '+' + line)
      .join('\n') + '\n'
}
const counts = {}
for (const path of paths) {
  if (map.files().includes(resolve(path)))
    counts[path] = istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
}
const result = lineReportFromCounts(changedLines(diff), counts, path =>
  paths.includes(path)
)
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify(result, null, 2)
)

// One row per changed file with changed runtime lines.
const rows = Object.entries(result.files)
  .map(([path, file]) => {
    const total = file.covered.length + file.uncovered.length
    return {
      path,
      covered: file.covered.length,
      total,
      percent: total === 0 ? 100 : (100 * file.covered.length) / total,
      uncovered: file.uncovered.sort((a, b) => a - b)
    }
  })
  .filter(row => row.total > 0)
const width = Math.max(4, ...rows.map(row => row.path.length))
console.log(
  `\n${'File'.padEnd(width)}      Lines      %  Uncovered changed lines`
)
for (const row of rows)
  console.log(
    `${row.path.padEnd(width)}  ${`${row.covered}/${row.total}`.padStart(9)}  ${row.percent.toFixed(1).padStart(5)}  ${row.uncovered.join(', ')}`
  )
for (const path of result.missing)
  console.log(`${path.padEnd(width)}  never loaded by any suite`)

const short = rows.filter(row => row.percent < 90)
const failures = [
  ...short.map(row => `${row.path} is at ${row.percent.toFixed(1)}%`),
  ...result.missing.map(path => `${path} was never loaded`),
  ...(result.percent < 90
    ? [`the total is at ${result.percent.toFixed(2)}%`]
    : [])
]
const summary = `Scoreboard event log changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total} lines) over ${rows.length} files, base ${base}`
if (failures.length > 0) {
  console.error(`\n${summary}\nBelow 90%: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`\n${summary}`)
