// The coverage gate for Tess: every changed runtime line of `src/**/*.ts(x)`
// since TS_COVERAGE_BASE (default: the merge base with origin/master), each
// file and the total.
//
//   npm run build.web
//   TS_DIRECT_BROWSER_COVERAGE=coverage/tessBrowser.json \
//     NODE_V8_COVERAGE=$PWD/coverage/tessE2eServer \
//     node -r sucrase/register src/app/tess/tess.e2e.ts   # its own env too
//   TS_DIRECT_BROWSER_COVERAGE=coverage/tessBrowser.json \
//     TS_TESS_SERVER_COVERAGE=coverage/tessE2eServer \
//     npm run coverage.tess -- [--allow-failing <pattern>]…
//
// The reports go to `coverage/tess/`, which each run clears; keep the
// end-to-end inputs outside it.
//
// The unit counters come from four runs under NODE_V8_COVERAGE: `npm test`'s
// bundle of every `.test.tsx` (`build-scoring-tests.mjs`), the app's
// `.test.ts` suites under the DOM setup, the server, common and migration
// `.test.ts` suites, and the native specs (`build-player-native-tests.mjs`),
// which are the only suites that load a `*.native.ts(x)` file. Every run has
// a 20-second test timeout and `--exit`, so one stuck test or open handle
// cannot hold up the rest.
//
// Two gates:
//   unit      the unit counters alone: every file the branch adds at least
//             90%, and the changed lines overall at least 90%;
//   combined  the unit counters merged with the Chromium end-to-end run's
//             browser coverage (istanbul JSON, TS_DIRECT_BROWSER_COVERAGE)
//             and, when given, that run's own V8 coverage of the server it
//             starts in-process (a NODE_V8_COVERAGE directory,
//             TS_TESS_SERVER_COVERAGE): at least 95% of changed executable
//             lines, per file and overall.
// A changed file no suite loaded fails both.
//
// Failing tests are reported apart from the coverage verdict, which is always
// computed. Each `--allow-failing <pattern>` is a regular expression matched
// against `<suite file> › <full test title>` (or `<run> exited <status>` for a
// run that crashed before reporting); a failure it matches is listed as
// allowed and does not fail the command. Use it only for a failure that also
// happens on origin/master, such as
//   --allow-failing 'src/migrate/runner\.test\.ts'   two 077 migrations
//   --allow-failing 'src/server/(live/splitter|media/ffmpeg)\.test\.ts'
//                                     an FFmpeg other than the pinned build
//
// Not measured: tests, specs, end-to-end and integration files, test
// tooling (`src/test/**`), type declarations, and files with no runtime
// statement (types, type-only imports and re-exports).
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { buildNativeSpecs } from './build-player-native-tests.mjs'

const unitMinimum = 90
const combinedMinimum = 95
const timeout = '20000'

const allowed = []
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--allow-failing' && process.argv[i + 1] != null)
    allowed.push(new RegExp(process.argv[++i]))
  else if (arg.startsWith('--allow-failing='))
    allowed.push(new RegExp(arg.slice('--allow-failing='.length)))
  else throw new Error(`Unknown argument ${arg}`)
}

function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}
const lines = text => text.split('\n').filter(line => line !== '')
const base =
  process.env.TS_COVERAGE_BASE ??
  git(['merge-base', 'origin/master', 'HEAD']).trim()

const report = resolve('coverage/tess')
const unitTemp = resolve(report, 'unit')
const results = resolve(report, 'results')
rmSync(report, { recursive: true, force: true })
mkdirSync(unitTemp, { recursive: true })
mkdirSync(results, { recursive: true })

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
  existsSync(path) &&
  !path.endsWith('.d.ts') &&
  !/\.(test|spec|e2e|integration|smoke)\./.test(path) &&
  !path.startsWith('src/test/') &&
  hasExecutableSource(path)

const untracked = lines(git(['ls-files', '--others', '--exclude-standard']))
const changed = lines(git(['diff', '--name-only', '--diff-filter=d', base]))
const paths = [...new Set([...changed, ...untracked])].filter(eligible).sort()
const added = new Set(
  [
    ...lines(git(['diff', '--name-only', '--diff-filter=A', base])),
    ...untracked
  ].filter(path => paths.includes(path))
)

// Each run writes mocha's JSON report, and the tests' own output goes to a log
// beside it; a run that dies before writing its report counts as one failure
// under its own name.
const failures = []
function mocha(name, args, setup) {
  const stem = relative(
    process.cwd(),
    resolve(results, name.replace(/\W+/g, '-'))
  )
  const output = `${stem}.json`
  const command = [
    '-r',
    'sucrase/register',
    ...(setup ? ['-r', './src/test/scoringDomSetup.cjs'] : []),
    '--timeout',
    timeout,
    '--exit',
    '--reporter',
    'json',
    '--reporter-option',
    `output=${output}`,
    ...args
  ]
  console.log(`\n$ mocha ${command.join(' ')} > ${stem}.log`)
  const log = openSync(`${stem}.log`, 'w')
  const started = Date.now()
  const result = spawnSync('node_modules/.bin/mocha', command, {
    stdio: ['ignore', log, log],
    env: { ...process.env, NODE_V8_COVERAGE: unitTemp }
  })
  closeSync(log)
  const seconds = ((Date.now() - started) / 1000).toFixed(0)
  if (!existsSync(output)) {
    console.log(
      `  ${name}: no report, exited ${result.status ?? result.signal} (${seconds} s)`
    )
    failures.push(`${name} exited ${result.status ?? result.signal}`)
    return
  }
  const { stats, failures: failed } = JSON.parse(readFileSync(output, 'utf8'))
  console.log(
    `  ${name}: ${stats.passes} passing, ${stats.failures} failing, ${stats.pending} pending (${seconds} s)`
  )
  for (const test of failed)
    failures.push(
      `${test.file == null ? name : relative(process.cwd(), test.file)} › ${test.fullTitle}`
    )
}

const build = spawnSync('node', ['scripts/build-scoring-tests.mjs'], {
  stdio: 'inherit'
})
if (build.status !== 0) process.exit(build.status ?? 1)
mocha('the bundled app tests', ['lib/scoring-tests.cjs'], true)
mocha(
  'the app .test.ts suites',
  ['--extension', 'ts', '--spec', 'src/app/**/*.test.ts'],
  true
)
mocha(
  'the server, common and migration suites',
  [
    '--extension',
    'ts',
    '--spec',
    'src/server/**/*.test.ts',
    '--spec',
    'src/common/**/*.test.ts',
    '--spec',
    'src/migrate/**/*.test.ts'
  ],
  false
)
for (const { spec, outfile } of await buildNativeSpecs(
  resolve('lib/tess-native-specs')
))
  mocha(spec, [outfile], true)

// Bundled sources are file URLs in the recorded source maps; c8 compares
// paths, and otherwise counts every bundled function covered.
function normaliseSourceMaps(directory) {
  for (const file of readdirSync(directory)) {
    const location = resolve(directory, file)
    const data = JSON.parse(readFileSync(location, 'utf8'))
    for (const map of Object.values(data['source-map-cache'] ?? {}))
      if (map.data?.sources != null)
        map.data.sources = map.data.sources.map(source =>
          source.startsWith('file://') ? fileURLToPath(source) : source
        )
    writeFileSync(location, JSON.stringify(data))
  }
}

const require = createRequire(import.meta.url)
const { createCoverageMap } = require('istanbul-lib-coverage')
function c8Report(temp, out) {
  normaliseSourceMaps(temp)
  const result = spawnSync(
    'node_modules/.bin/c8',
    [
      'report',
      '--temp-directory',
      temp,
      '--reporter=json',
      '--reports-dir',
      out,
      '--exclude-after-remap',
      ...paths.flatMap(path => ['--include', path]),
      '--exclude',
      '**/*.test.*',
      '--exclude',
      '**/*.spec.*',
      '--exclude',
      '**/*.e2e.*',
      '--exclude',
      'src/test/**'
    ],
    { stdio: 'inherit' }
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
  return createCoverageMap(
    JSON.parse(readFileSync(resolve(out, 'coverage-final.json'), 'utf8'))
  )
}
const unitMap = c8Report(unitTemp, resolve(report, 'unitReport'))
const combinedMap = createCoverageMap(unitMap.toJSON())
const serverCoverage = process.env.TS_TESS_SERVER_COVERAGE
if (serverCoverage != null) {
  const temp = resolve(report, 'e2eServer')
  cpSync(resolve(serverCoverage), temp, { recursive: true })
  combinedMap.merge(c8Report(temp, resolve(report, 'e2eServerReport')))
}
const browserCoverage = process.env.TS_DIRECT_BROWSER_COVERAGE
if (browserCoverage != null)
  combinedMap.merge(JSON.parse(readFileSync(browserCoverage, 'utf8')))
writeFileSync(
  resolve(report, 'coverage-final.json'),
  JSON.stringify(combinedMap.toJSON())
)

const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
let diff =
  paths.length > 0
    ? git(['diff', '--unified=0', '--find-renames', base, '--', 'src'])
    : ''
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
const changes = Object.fromEntries(
  Object.entries(changedLines(diff)).filter(([path]) => paths.includes(path))
)
function gate(map, options) {
  const counts = {}
  for (const path of paths)
    if (map.files().includes(resolve(path)))
      counts[path] = istanbulCounts(map.fileCoverageFor(resolve(path)).toJSON())
  return lineReportFromCounts(changes, counts, () => true, options)
}
const unit = gate(unitMap, {
  newFiles: [...added],
  newFileMin: unitMinimum,
  min: unitMinimum
})
const combined = gate(combinedMap, { min: combinedMinimum })
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify({ base, unit, combined }, null, 2)
)

// `1, 2, 3, 7` as `1-3, 7`.
function ranges(numbers) {
  const out = []
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const last = out[out.length - 1]
    if (last != null && last[1] === n - 1) last[1] = n
    else out.push([n, n])
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')
}

const width = Math.max(4, ...paths.map(path => path.length))
const verdicts = []
function table(title, result, minimumFor) {
  console.log(`\n${title}`)
  console.log(
    `${'File'.padEnd(width)}      Lines      %  Uncovered changed lines`
  )
  const short = []
  for (const [path, file] of Object.entries(result.files).sort()) {
    const total = file.covered.length + file.uncovered.length
    if (total === 0) continue
    const percent = (100 * file.covered.length) / total
    const minimum = minimumFor(path)
    const mark = minimum != null && percent < minimum ? ' <' : '  '
    if (mark !== '  ') short.push(`${path} at ${percent.toFixed(1)}%`)
    console.log(
      `${path.padEnd(width)}${mark}${`${file.covered.length}/${total}`.padStart(9)}  ${percent.toFixed(1).padStart(5)}  ${ranges(file.uncovered)}`
    )
  }
  for (const path of result.missing) {
    short.push(`${path} never loaded`)
    console.log(`${path.padEnd(width)}  never loaded by any suite`)
  }
  return short
}

const unitShort = table(
  `Unit only: each new file and the total at least ${unitMinimum}% (new files marked *)`,
  {
    ...unit,
    files: Object.fromEntries(
      Object.entries(unit.files).map(([path, file]) => [
        added.has(path) ? `${path} *` : path,
        file
      ])
    ),
    missing: unit.missing
  },
  path => (path.endsWith(' *') ? unitMinimum : null)
)
if (unit.total > 0 && unit.percent < unitMinimum)
  unitShort.push(`the unit total at ${unit.percent.toFixed(2)}%`)
console.log(
  `Unit changed runtime coverage: ${unit.percent.toFixed(2)}% (${unit.covered}/${unit.total} lines), new files ${Object.keys(unit.newFiles).length}`
)
verdicts.push(...unitShort.map(entry => `unit: ${entry}`))

const sources = [
  'unit',
  ...(serverCoverage != null ? ['end-to-end server'] : []),
  ...(browserCoverage != null ? ['Chromium'] : [])
]
const combinedShort = table(
  `Combined (${sources.join(' + ')}): each file and the total at least ${combinedMinimum}%`,
  combined,
  () => combinedMinimum
)
if (combined.total > 0 && combined.percent < combinedMinimum)
  combinedShort.push(`the combined total at ${combined.percent.toFixed(2)}%`)
console.log(
  `Combined changed runtime coverage: ${combined.percent.toFixed(2)}% (${combined.covered}/${combined.total} lines) over ${Object.keys(combined.files).length} files`
)
verdicts.push(...combinedShort.map(entry => `combined: ${entry}`))
if (browserCoverage == null)
  verdicts.push('combined: TS_DIRECT_BROWSER_COVERAGE was not supplied')

const native = Object.entries(combined.files).filter(([path]) =>
  /\.native\.tsx?$/.test(path)
)
if (native.length > 0) {
  console.log('\nNative-only files (measured by the native specs):')
  for (const [path, file] of native) {
    const total = file.covered.length + file.uncovered.length
    console.log(
      `  ${path}: ${total === 0 ? 'no changed runtime lines' : `${((100 * file.covered.length) / total).toFixed(1)}% (${file.covered.length}/${total})`}`
    )
  }
}

const allowedFailures = failures.filter(name =>
  allowed.some(pattern => pattern.test(name))
)
const failing = failures.filter(name => !allowedFailures.includes(name))
console.log(`\nTest failures: ${failures.length}`)
for (const name of allowedFailures) console.log(`  allowed  ${name}`)
for (const name of failing) console.log(`  FAILING  ${name}`)

console.log(
  `\nCoverage verdict (base ${base}): ${verdicts.length === 0 ? 'PASS' : 'FAIL'}`
)
for (const entry of verdicts) console.log(`  ${entry}`)
console.log(
  `Tests: ${failing.length === 0 ? 'PASS' : 'FAIL'} (${failing.length} failing, ${allowedFailures.length} allowed)`
)
process.exit(verdicts.length === 0 && failing.length === 0 ? 0 : 1)
