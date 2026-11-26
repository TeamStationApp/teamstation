import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  jsCounts,
  jsIncludes,
  readJson,
  runGates,
  sourceStamp
} from './tab-bar-line-gates.mjs'

// Measure the PR's changes even when its target advances during development.
const base = execFileSync(
  'git',
  ['merge-base', process.env.TS_COVERAGE_BASE ?? 'origin/develop', 'HEAD'],
  { encoding: 'utf8' }
).trim()
const source = sourceStamp()
const report = resolve('coverage/tabBar')
mkdirSync(report, { recursive: true })
const specs = [
  'src/app/components/AppNav.test.tsx',
  'src/app/components/AppSidebar.test.tsx'
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
    'scripts/tab-bar-line-gates.test.mjs',
    'src/server/tess/sitemapNavigation.test.ts',
    bundle
  ],
  { stdio: 'inherit' }
)
const unit = jsCounts(readJson(resolve(report, 'coverage-final.json')))
runGates('js', source, unit, [], base, report)
