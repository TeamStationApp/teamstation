import { spawnSync } from 'node:child_process'
import {
  globSync,
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

const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error('Set TS_COVERAGE_BASE to the follow-up parent')
const report = resolve('coverage/settingsCleanup2')
const temp = resolve(report, 'tmp')
const reportOnly = process.argv.includes('--report-only')
const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const git = args => {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
if (!reportOnly) rmSync(temp, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
mkdirSync('lib', { recursive: true })
const uiPatterns = [
  'src/app/components/GameHeroCard.test.tsx',
  'src/app/screens/TeamScreen.pending.test.tsx',
  'src/app/screens/SeasonParticipations.test.tsx',
  'src/app/screens/GroupRelationshipRow.test.tsx',
  'src/app/screens/NodeAdministrationScreen.test.tsx',
  'src/app/screens/groupCreation.test.tsx',
  'src/app/screens/settingsPeople.test.tsx',
  'src/app/screens/GroupSettingsScreen.test.tsx',
  'src/app/screens/LocationScreen.test.tsx',
  'src/app/screens/PlayerScreen.test.tsx',
  'src/app/screens/expandedStats.test.tsx',
  'src/app/screens/GameScreen*.test.tsx',
  'src/app/screens/gameCardScrolls.test.tsx',
  'src/app/screens/GameWatchLayout*.test.tsx',
  'src/app/screens/BoxScore.test.tsx',
  'src/app/screens/teamNonMember.test.tsx',
  'src/app/screens/Season*.test.tsx',
  'src/app/screens/League*.test.tsx',
  'src/app/screens/GamesFeedScreen.test.tsx',
  'src/app/screens/creationUi.test.tsx',
  'src/app/screens/JoinScreen.test.tsx',
  'src/app/components/settingsPieces.test.tsx',
  'src/app/components/BreakParentSheet.test.tsx',
  'src/app/components/usePinnedHead*.test.tsx',
  'src/app/components/StickySectionLayout*.test.tsx',
  'src/app/scoreboard/scoreGameEntry.test.tsx',
  'src/app/scoring/scoringEntry.test.tsx'
]
if (!reportOnly) {
  await build({
    ...webSettings,
    alias: {
      ...webSettings.alias,
      'react-native-webview': './src/test/eventWebViewStub.tsx',
      'react-native-maps': './src/test/eventNativeMapStub.tsx',
      '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts'
    },
    stdin: {
      contents: globSync(uiPatterns)
        .map(file => `import './${file}'`)
        .join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'settings-cleanup-2-tests.ts'
    },
    outfile: 'lib/settings-cleanup-2-tests.cjs',
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
      TS_API_BASE_URL: JSON.stringify('/api/v1'),
      'process.env.TS_SENTRY_DSN': JSON.stringify(''),
      'process.env.NODE_ENV': JSON.stringify('test')
    },
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
  })
  run(
    'node_modules/.bin/mocha',
    [
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      '--timeout',
      '60000',
      'lib/settings-cleanup-2-tests.cjs'
    ],
    { NODE_V8_COVERAGE: temp }
  )
  run(
    'node_modules/.bin/mocha',
    [
      '-r',
      'sucrase/register',
      '--timeout',
      '60000',
      'src/server/admin/nodeAdministration.test.ts',
      'src/server/email/accountMail.test.ts',
      'src/server/openapi.test.ts',
      'src/common/api.test.ts',
      'src/app/components/pinnedHead.test.ts'
    ],
    { NODE_V8_COVERAGE: temp }
  )
  if (git(['diff', '--name-only', base, '--', 'src/server/index.ts']) !== '') {
    const artifacts = process.env.TS_CREATION_ARTIFACTS
    if (artifacts == null)
      throw new Error(
        'Set TS_CREATION_ARTIFACTS for the production entry smoke'
      )
    run(
      'node',
      ['-r', 'sucrase/register', 'src/test/refinementsStartup.e2e.ts'],
      {
        TS_REFINEMENTS_ARTIFACTS: artifacts,
        TS_REFINEMENTS_STARTUP_V8: temp
      }
    )
  }
}
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
run('node_modules/.bin/c8', [
  'report',
  '--temp-directory',
  temp,
  '--reporter=text',
  '--reporter=json',
  '--reports-dir',
  report,
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
if (process.env.TS_SETTINGS2_BROWSER_COVERAGE != null)
  map.merge(
    JSON.parse(readFileSync(process.env.TS_SETTINGS2_BROWSER_COVERAGE, 'utf8'))
  )
writeFileSync(
  resolve(report, 'coverage-final.json'),
  JSON.stringify(map.toJSON())
)
const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .split('\n')
  .filter(Boolean)
const paths = [
  ...new Set([...git(['diff', '--name-only', base]).split('\n'), ...untracked])
].filter(path => {
  if (
    !/^src\/(app|common|server)\//.test(path) ||
    !/\.tsx?$/.test(path) ||
    /\.(test|e2e|smoke)\./.test(path) ||
    /\.d\.ts$/.test(path) ||
    ['src/app/locales/en_US.ts', 'src/server/openapi.ts'].includes(path)
  )
    return false
  // Interfaces and type aliases have no emitted runtime to measure.
  const output = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      removeComments: true
    }
  }).outputText
  return output.replace(/export\s*\{\s*\};?/g, '').trim() !== ''
})
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
const result = lineReportFromCounts(changedLines(diff), counts, path =>
  paths.includes(path)
)
writeFileSync(
  resolve(report, 'changed-lines.json'),
  JSON.stringify(result, null, 2)
)
const failures = Object.entries(result.files).filter(([, lines]) => {
  const total = lines.covered.length + lines.uncovered.length
  return total > 0 && lines.covered.length / total < 0.9
})
console.log(
  `Settings cleanup 2 changed runtime coverage: ${result.percent.toFixed(2)}% (${result.covered}/${result.total} lines)`
)
if (failures.length > 0 || !result.pass || result.total === 0)
  throw new Error(
    `At least 90% changed runtime line coverage required: ${JSON.stringify(failures)}`
  )
