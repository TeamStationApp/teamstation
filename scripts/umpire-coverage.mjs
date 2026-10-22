import { spawnSync } from 'node:child_process'
import {
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { webSettings } from './web-build-settings.mjs'
const report = resolve('coverage/umpires')
const temp = resolve(report, 'tmp')
const reportOnly = process.argv.includes('--report-only')
if (!reportOnly) rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
mkdirSync('lib', { recursive: true })
function run(cmd, args, env = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (!reportOnly) {
  await build({
    ...webSettings,
    alias: {
      ...webSettings.alias,
      'react-native-svg': './src/test/umpireSvgStub.tsx'
    },
    stdin: {
      contents: [
        ...globSync('src/app/umpires/*.test.tsx'),
        'src/app/screens/GroupSettingsScreen.test.tsx',
        'src/app/screens/relationshipAccess.test.tsx',
        'src/app/screens/settingsPeople.test.tsx',
        'src/app/components/Card.test.tsx',
        'src/app/components/gameLiveCards.test.tsx',
        'src/app/screens/GamesFeedScreen.test.tsx',
        'src/app/screens/teamSchedule.test.tsx',
        'src/app/screens/PublicTeamContent.test.tsx',
        'src/app/screens/SeasonScreen.test.tsx',
        'src/app/components/Wheel.test.tsx',
        'src/app/navigation/scoringNativeBack.test.tsx',
        'src/app/scoring/scoringShell.test.tsx',
        'src/app/scoring/ScoringPlayerSettingsFlow.test.tsx',
        'src/app/components/EventScheduleFields.test.tsx',
        'src/app/screens/GameScreen.eventInfo.test.tsx',
        'src/app/screens/EventInfoTab.test.tsx',
        'src/app/scoring/UndoTicker.test.tsx',
        'src/app/components/TextWidthButton.test.tsx',
        'src/app/components/PillTabs.test.tsx',
        'src/app/components/TickerText.test.tsx',
        'src/app/components/StickySectionLayout.native.test.tsx',
        'src/app/components/pillGeometry.test.tsx',
        'src/app/scoring/DictationButton.test.tsx',
        'src/app/screens/PlayerSettingsTab.test.tsx',
        'src/app/scoring/PlayerEntrySheet.test.tsx',
        'src/app/scoring/scoringUiPolish.test.tsx',
        'src/app/scoring/scoringSheetTheme.test.tsx'
      ]
        .map(p => `import './${p}'`)
        .join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'umpire-test-entry.ts'
    },
    outfile: 'lib/umpire-tests.cjs',
    platform: 'node',
    format: 'cjs',
    bundle: true,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'jsdom', 'mocha', 'chai'],
    sourcemap: true,
    define: {
      __DEV__: 'true',
      TS_API_BASE_URL: JSON.stringify('/api/v1'),
      'process.env.NODE_ENV': JSON.stringify('test')
    },
    loader: { '.png': 'dataurl', '.svg': 'dataurl' }
  })
  run(
    'node_modules/.bin/mocha',
    ['-r', './src/test/scoringDomSetup.cjs', '--exit', 'lib/umpire-tests.cjs'],
    { NODE_V8_COVERAGE: temp }
  )
}
for (const file of readdirSync(temp)) {
  const path = resolve(temp, file)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {}))
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(s =>
        s.startsWith('file://') ? fileURLToPath(s) : s
      )
  writeFileSync(path, JSON.stringify(data))
}
run('node_modules/.bin/c8', [
  'report',
  '--temp-directory',
  temp,
  '--reporter=text',
  '--reporter=json',
  '--reporter=json-summary',
  '--reports-dir',
  report,
  '--exclude-after-remap',
  '--include',
  'src/app/**',
  '--include',
  'src/common/**',
  '--exclude',
  '**/*.test.*'
])

run(process.execPath, ['scripts/umpire-combined-coverage.mjs', '--ui-only'])
