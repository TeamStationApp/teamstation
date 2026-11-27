import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  jsCounts,
  jsIncludes,
  readJson,
  runGates,
  sourceStamp
} from './tab-bar-line-gates.mjs'
import { measureNative } from './tab-bar-native-coverage.mjs'

// Measure the PR's changes even when its target advances during development.
const base = execFileSync(
  'git',
  ['merge-base', process.env.TS_COVERAGE_BASE ?? 'origin/develop', 'HEAD'],
  { encoding: 'utf8' }
).trim()
const { values } = parseArgs({
  options: {
    'js-only': { type: 'boolean' },
    supplement: { type: 'string', multiple: true, default: [] }
  }
})
const source = sourceStamp()
const supplements = values.supplement.map(readJson)
const report = resolve('coverage/tabBar')
mkdirSync(report, { recursive: true })
const specs = [
  'src/app/App.navbarPop.test.tsx',
  'src/app/App.offlineBanner.test.tsx',
  'src/app/chat/chat2ActionsView.test.tsx',
  'src/app/chat/chat2ViewportView.test.tsx',
  'src/app/walkup/DjGameScreen.test.tsx',
  'src/app/screens/LocationScreen.test.tsx',
  'src/app/scoreboard/ScoreboardOverrideScreen.test.tsx',
  'src/app/screens/GameWatchLayout.test.tsx',
  'src/app/screens/GameWatchLayout.native.test.tsx',
  'src/app/theme/navContrast.test.ts',
  'src/app/components/AppNav.test.tsx',
  'src/app/components/AppSidebar.test.tsx',
  'src/app/components/AppNavCapsule.test.tsx',
  'src/app/components/capsuleMotion.test.tsx',
  'src/app/components/useMotionPreference.test.tsx',
  'src/app/components/TabPages.test.tsx',
  'src/app/components/navGeometry.test.ts',
  'src/app/components/SystemTabBar.native.test.ts',
  'src/app/components/reducedTransparency.test.tsx',
  'src/app/components/navCompactProvider.test.tsx',
  'src/app/components/navCompact.test.tsx',
  'src/app/components/tabBarModel.test.ts',
  'src/app/components/navClearance.test.ts',
  'src/app/components/SuccessToast.test.tsx',
  'src/app/components/StickySectionLayout.native.test.tsx'
]
const bundle = resolve('lib/tab-bar-tests.cjs')
execFileSync(
  process.execPath,
  [
    'scripts/build-scoring-tests.mjs',
    '--output=' + bundle,
    ...specs.map(file => '--spec=' + file)
  ],
  { stdio: 'inherit' }
)
execFileSync(
  resolve('node_modules/.bin/c8'),
  [
    '--reporter=json',
    '--reporter=text',
    '--reports-dir',
    report,
    '--exclude-after-remap',
    ...jsIncludes.flatMap(scope => ['--include', scope]),
    resolve('node_modules/.bin/mocha'),
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    '--timeout',
    '20000',
    '--exit',
    'e2e/rigs/refinementsMaestro.test.ts',
    'e2e/core/maestro.test.ts',
    'scripts/tab-bar-native-coverage.test.mjs',
    'scripts/tab-bar-line-gates.test.mjs',
    'src/server/tess/sitemapNavigation.test.ts',
    bundle
  ],
  { stdio: 'inherit' }
)
const unit = jsCounts(readJson(resolve(report, 'coverage-final.json')))
runGates('js', source, unit, supplements, base, report)
if (!values['js-only'])
  runGates(
    'native',
    source,
    measureNative(base, report),
    supplements,
    base,
    report
  )
