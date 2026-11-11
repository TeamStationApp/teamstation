import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { build } from 'esbuild'

import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

// Line coverage of what the display names and images work adds and changes
// (the plan's milestones each append their suites), from the suites that
// exercise it. The gate reads the diff from `TS_COVERAGE_BASE` (origin/develop
// unless given) to HEAD, so it runs after the commit, and asks 95% of each
// changed file's executable lines under src/server, src/common and src/app,
// tests, fixtures and end-to-end files left out: the combined unit and
// integration gate AGENTS.md sets.
const base = process.env.TS_COVERAGE_BASE ?? 'origin/develop'
const specs = [
  // M1: who may see a full name (`mayViewFullNames`) and its callers.
  'src/server/access.integration.test.ts',
  'src/server/users/readerNames.integration.test.ts',
  'src/server/groups/playerNamePrivacyReads.integration.test.ts',
  'src/server/groups/noticePolicy.integration.test.ts',
  'src/server/routes/players.integration.test.ts',
  'src/server/routes/people.integration.test.ts',
  'src/server/routes/guardians.integration.test.ts',
  'src/server/users/peopleCandidates.integration.test.ts',
  'src/server/teams/teamRoster.integration.test.ts',
  'src/server/events/eventInfo.integration.test.ts',
  'src/server/routes/chat.integration.test.ts',
  'src/server/users/nameBook.integration.test.ts',
  'src/server/teams/onPeopleList.unit.test.ts',
  'src/server/teams/headCoachViews.unit.test.ts'
]
// `.tsx` specs run from one bundle, with the web's `react-native`.
const screens = []

const database = spawnSync('node', ['src/migrate/requirePostgres18.js'], {
  stdio: 'inherit'
})
if (database.status !== 0) process.exit(1)
const report = resolve('coverage/displayNames')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

const bundle = 'lib/display-names-tests.cjs'
if (screens.length > 0)
  await build({
    ...webSettings,
    // Paged lists render as the app suites render them (build-scoring-tests).
    plugins: [...webSettings.plugins, pagedListStandInPlugin()],
    alias: {
      ...webSettings.alias,
      'react-native-webview': './src/test/eventWebViewStub.tsx',
      'react-native-maps': './src/test/eventNativeMapStub.tsx'
    },
    stdin: {
      contents: screens.map(file => `import './${file}'`).join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'display-names-tests.ts'
    },
    outfile: bundle,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'jsdom', 'mocha', 'chai'],
    sourcemap: true,
    define: {
      ...webSettings.define,
      __DEV__: 'true',
      TS_API_BASE_URL: JSON.stringify('/api/v1'),
      'process.env.NODE_ENV': JSON.stringify('test')
    },
    loader: { '.png': 'dataurl', '.svg': 'dataurl' }
  })

const run = (command, args, env = process.env) => {
  console.log('$', command, ...args)
  return spawnSync(command, args, { stdio: 'inherit', env }).status ?? 1
}

const tests = run(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    '--timeout',
    '60000',
    '--extension',
    'ts',
    '--reporter',
    'dot',
    '--exit',
    ...specs.flatMap(spec => ['--spec', spec]),
    ...(screens.length > 0 ? ['--spec', bundle] : [])
  ],
  { ...process.env, NODE_V8_COVERAGE: temp }
)
const coverage = run('node_modules/.bin/c8', [
  'report',
  '--reporter=text',
  '--reporter=json',
  '--reports-dir',
  report,
  '--temp-directory',
  temp,
  '--include',
  'src/**/*.ts',
  '--include',
  'src/**/*.tsx',
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude',
  'src/test/**',
  '--exclude-after-remap'
])
const gate = run('node', [
  'scripts/changed-line-check.cjs',
  '--base',
  base,
  '--coverage',
  resolve(report, 'coverage-final.json'),
  '--report',
  resolve(report, 'changed-95.json'),
  '--min',
  '95',
  '--ext',
  '.ts',
  '--ext',
  '.tsx',
  '--exclude',
  'src/test',
  '--exclude',
  '**/*.fixture.*',
  'src/server',
  'src/common',
  'src/app'
])
process.exit(tests || coverage || gate)
