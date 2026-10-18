// Combined regression coverage for scoring tweaks. All counters come from
// original sources at this revision; every changed production file must pass.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const require = createRequire(import.meta.url)
const {
  coverageSource,
  verifyCoverageSource
} = require('./coverage-provenance.cjs')
const {
  changedLines,
  istanbulCounts,
  lineReportFromCounts
} = require('./changed-line-coverage.cjs')
const base = process.env.TS_COVERAGE_BASE ?? 'origin/master'
const out = resolve('coverage/scoringTweaks')
const temp = resolve('coverage/tmp')
const provenanceFile = resolve(out, 'counter-source.json')
const provenance = process.argv.includes('--report-only')
  ? JSON.parse(readFileSync(provenanceFile, 'utf8'))
  : coverageSource(process.cwd(), base)
verifyCoverageSource(provenance, process.cwd(), base)
const run = (command, args, env = {}) => {
  console.log('$', command, ...args)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      TS_COVERAGE_BASE: base,
      // Node supports these natively. Downlevel helpers otherwise map their
      // unused generic branches onto the first import's source line.
      SUCRASE_OPTIONS: JSON.stringify({ disableESTransforms: true }),
      ...env
    }
  })
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`)
}
const git = args => execFileSync('git', args, { encoding: 'utf8' })
const runtime = path => {
  if (
    !path.startsWith('src/') ||
    !/\.tsx?$/.test(path) ||
    /\.(test|integration|e2e)\./.test(path) ||
    path.startsWith('src/test/') ||
    path.endsWith('.d.ts')
  )
    return false
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
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement)
  )
}
if (!process.argv.includes('--report-only')) {
  run('node', ['scripts/build-scoring-tests.mjs', '--current-setup'])
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  mkdirSync(out, { recursive: true })
  writeFileSync(provenanceFile, JSON.stringify(provenance))
  run('node', ['--test', 'scripts/coverage-provenance.test.cjs'])
  run(
    'node_modules/.bin/mocha',
    [
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      '--timeout',
      '20000',
      '--exit',
      'src/common/scoring/*.test.ts',
      'src/app/scoring/*.test.ts',
      'src/app/field/*.test.ts',
      'lib/current-setup-tests.cjs'
    ],
    { NODE_V8_COVERAGE: temp }
  )
  const serverTests = [
    'src/server/stats/engineStats.test.ts',
    'src/server/stats/expandedStats.test.ts',
    'src/server/stats/gumboStats.test.ts',
    'src/server/events/radarSpeeds.test.ts',
    'src/server/events/events.test.ts',
    'src/server/events/actionTimes.test.ts',
    'src/server/events/playEventTimes.test.ts',
    'src/server/events/eventWrite.test.ts',
    'src/server/scoreboard/scoreboardLog.test.ts',
    'src/server/scoreboard/scoreboardStore.test.ts',
    'src/server/scoreboard/boardTimeline.test.ts',
    'src/server/scoreboard/gameSource.test.ts',
    'src/server/nodeSettings.test.ts',
    'src/common/nodeSettings.test.ts',
    'src/common/gumbo/validate.test.ts',
    'src/server/openapi.test.ts',
    'src/server/dev/refoldScoredGames.test.ts'
  ].filter(existsSync)
  run(
    'node_modules/.bin/mocha',
    ['-r', 'sucrase/register', '--timeout', '60000', ...serverTests],
    { NODE_V8_COVERAGE: temp }
  )
  const { build } = await import('esbuild')
  const { webSettings } = await import('./web-build-settings.mjs')
  for (const suite of [
    'NodeSettingsCard',
    'NodeAdministrationScreen',
    'Wheel',
    'EventScheduleFields'
  ]) {
    const file = `src/app/${['Wheel', 'EventScheduleFields'].includes(suite) ? 'components' : 'screens'}/${suite}.test.tsx`
    const bundle = `lib/scoring-tweaks-${suite}.cjs`
    await build({
      ...webSettings,
      entryPoints: [file],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      sourcemap: true,
      jsx: 'automatic',
      loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' },
      external: [
        'react',
        'react-dom',
        'chai',
        'mocha',
        'jsdom',
        'three',
        '@react-three/fiber'
      ],
      define: {
        __DEV__: 'true',
        TS_API_BASE_URL: JSON.stringify('/api/v1'),
        'process.env.TS_SENTRY_DSN': JSON.stringify(''),
        'process.env.NODE_ENV': '"test"'
      }
    })
    run(
      'node_modules/.bin/mocha',
      ['-r', './src/test/scoringDomSetup.cjs', '--exit', bundle],
      { NODE_V8_COVERAGE: temp }
    )
  }
}
mkdirSync(out, { recursive: true })
verifyCoverageSource(provenance, process.cwd(), base)
for (const file of readdirSync(temp)) {
  const path = resolve(temp, file)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {}))
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  writeFileSync(path, JSON.stringify(data))
}
const changes = Object.fromEntries(
  Object.entries(
    changedLines(git(['diff', '--unified=0', base, '--', 'src']))
  ).filter(([path]) => existsSync(path) && runtime(path))
)
run('node_modules/.bin/c8', [
  'report',
  '--temp-directory',
  temp,
  '--reports-dir',
  out,
  '--all',
  '--reporter=json',
  ...Object.keys(changes).flatMap(path => ['--include', path]),
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude',
  '**/*.integration.*',
  '--exclude-after-remap'
])
const counts = {}
for (const [path, entry] of Object.entries(
  JSON.parse(readFileSync(resolve(out, 'coverage-final.json'), 'utf8'))
))
  counts[relative(process.cwd(), path)] = istanbulCounts(entry)
const report = lineReportFromCounts(changes, counts, runtime, {
  min: 95,
  newFileMin: 95,
  newFiles: git(['diff', '--name-only', '--diff-filter=A', base])
    .trim()
    .split('\n')
})
const short = []
for (const [path, file] of Object.entries(report.files)) {
  const total = file.covered.length + file.uncovered.length
  const percent = total === 0 ? 100 : (file.covered.length * 100) / total
  console.log(
    `${percent.toFixed(2)}% ${path}${file.uncovered.length ? ` uncovered: ${file.uncovered.join(',')}` : ''}`
  )
  if (percent < 95) short.push(path)
}
report.pass &&= short.length === 0
verifyCoverageSource(provenance, process.cwd(), base)
writeFileSync(
  resolve(out, 'changed-lines.json'),
  JSON.stringify(
    {
      ...report,
      shortFiles: short,
      revision: provenance.revision,
      source: provenance
    },
    null,
    2
  )
)
console.log(
  `Combined changed lines: ${report.covered}/${report.total} (${report.percent.toFixed(2)}%); missing: ${report.missing.join(', ') || 'none'}`
)
if (!report.pass) process.exitCode = 1
