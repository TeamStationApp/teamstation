import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { build } from 'esbuild'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { UNIT_SERVERS } from './testTiers.mjs'
import { webSettings } from './web-build-settings.mjs'

// Line coverage of umpire availability: the saved filter per person and
// league, its match, the routes that save, read and query it (and the
// leaderboard's paging, which shares their bounded-integer parser), the
// commitments read, the profile and list fields, GraphQL and Tess's prompt,
// and the schedule's Save filter and the saved filter it applies, from the
// suites that exercise them. Each file the work adds must have 95%
// of its lines covered and each file it edits 95% of the lines it changes,
// read from `TS_COVERAGE_BASE` (origin/develop unless given) to HEAD, the
// repository's combined bar. `--screens` runs only the app suites, with no
// database and no gate; `TS_UMPIRE_AVAILABILITY_SCREENS=a,b` narrows them.
const base = process.env.TS_COVERAGE_BASE ?? 'origin/develop'
const screensOnly = process.argv.includes('--screens')
const specs = [
  'src/common/umpireTime.test.ts',
  'src/common/umpireCleaners.test.ts',
  'src/common/api.test.ts',
  'src/server/umpires/availability.integration.test.ts',
  'src/server/umpires/availabilityTess.integration.test.ts',
  'src/server/umpires/admin.integration.test.ts',
  // The shared bounded-integer parser's other caller, the leaderboard pages.
  'src/server/umpires/leaderboardPages.integration.test.ts',
  'src/server/routes/people.integration.test.ts',
  'src/server/graphql/graphql.integration.test.ts',
  'src/server/tess/prompt.test.ts',
  'src/server/tess/denyList.test.ts',
  'src/server/openapi.test.ts',
  'src/server/auth/apiKeyFamilies.test.ts',
  'src/migrate/runner.integration.test.ts',
  'src/app/navigation/routes.test.ts'
]
// `.tsx` specs run from one bundle, with the web's `react-native`.
const screens = ['src/app/umpires/scheduleUi.test.tsx'].filter(
  file =>
    existsSync(file) &&
    (process.env.TS_UMPIRE_AVAILABILITY_SCREENS == null ||
      process.env.TS_UMPIRE_AVAILABILITY_SCREENS.split(',').some(part =>
        file.includes(part)
      ))
)
// Account settings' slide-to-delete drags are timed against the wall clock,
// which coverage slows past what they allow; they run in npm test.
const slowUnderCoverage = 'Account settings screen .*(behind a slide|deleted)'
// Added whole: 95% of every line, from the unit and integration suites together.
const required = [
  'src/migrate/migrations/128umpireAvailability.ts',
  'src/server/umpires/availability.ts',
  'src/server/umpires/queryInteger.ts'
]
// Edited: 95% of the lines the branch changes, from the suites together.
const edited = [
  'src/common/umpireTime.ts',
  'src/common/umpireCleaners.ts',
  'src/common/api.ts',
  'src/migrate/migrations/index.ts',
  'src/server/routes/umpires.ts',
  'src/server/umpires/admin.ts',
  'src/server/teams/personProfile.ts',
  'src/server/umpires/schedule.ts',
  'src/server/umpires/openApi.ts',
  'src/server/openapi.ts',
  'src/server/auth/apiKeyFamilies.ts',
  'src/server/graphql/schema.ts',
  'src/server/tess/prompt.ts',
  'src/app/navigation/routes.ts',
  'src/app/locales/en_US.ts',
  'src/app/umpires/UmpireScheduleScreen.tsx'
]

if (!screensOnly) {
  const database = spawnSync('node', ['src/migrate/requirePostgres18.js'], {
    stdio: 'inherit'
  })
  if (database.status !== 0) process.exit(1)
}
const report = resolve('coverage/umpireAvailability')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

const bundle = 'lib/umpire-availability-tests.cjs'
if (screens.length > 0)
  await build({
    ...webSettings,
    // As build-scoring-tests bundles the app suites.
    plugins: [
      ...webSettings.plugins,
      chatCoreResolvePlugin(),
      pagedListStandInPlugin(),
      {
        name: 'native-initials-measurement-unit',
        setup(build) {
          build.onLoad({ filter: /FittedInitials\.native\.tsx$/ }, args => ({
            contents: readFileSync(args.path, 'utf8').replace(
              "from 'react-native'",
              "from '../../test/nativeInitialsTextStub'"
            ),
            loader: 'tsx'
          }))
        }
      }
    ],
    alias: {
      ...webSettings.alias,
      'react-native/Libraries/Utilities/DevLoadingView':
        './src/test/tvDevLoadingStub.ts',
      'react-native-webview': './src/test/eventWebViewStub.tsx',
      'react-native-maps': './src/test/eventNativeMapStub.tsx',
      '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts',
      '@react-native-community/geolocation': './src/test/geolocationStub.ts',
      '@react-native/assets-registry/registry':
        'react-native-web/dist/modules/AssetRegistry'
    },
    stdin: {
      // Each file in a suite of its own, so the hooks it declares outside its
      // describe blocks run for its tests alone.
      contents: [
        "import { describe } from 'mocha'",
        ...screens.map(
          file => `describe('', () => {\n  require('./${file}')\n})`
        )
      ].join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'umpire-availability-tests.ts'
    },
    outfile: bundle,
    platform: 'node',
    format: 'cjs',
    bundle: true,
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
    sourcemap: true,
    define: {
      __DEV__: 'true',
      TS_CHAT_NODE_ADDON: JSON.stringify(
        resolve('src/common/chatCrypto/node/chat_crypto.node')
      ),
      TS_API_BASE_URL: JSON.stringify('/api/v1'),
      'process.env.TS_SENTRY_DSN': JSON.stringify(''),
      'process.env.NODE_ENV': JSON.stringify('test')
    },
    loader: ASSET_LOADER
  })

const run = (command, args, env = process.env) => {
  console.log('$', command, ...args)
  return spawnSync(command, args, { stdio: 'inherit', env }).status ?? 1
}

const mocha = (files, reporter, extra = []) => [
  '-r',
  'sucrase/register',
  '-r',
  './src/test/scoringDomSetup.cjs',
  ...extra,
  '--timeout',
  '60000',
  '--extension',
  'ts',
  '--reporter',
  reporter,
  '--exit',
  ...files.flatMap(file => ['--spec', file])
]
// The server suites, on the database; the app's, as the unit tier runs them,
// where any server they reach refuses at once (unitTierGuard).
const server = screensOnly
  ? 0
  : run('node_modules/.bin/mocha', mocha(specs, 'dot'), {
      ...process.env,
      NODE_V8_COVERAGE: temp
    })
const app =
  screens.length === 0
    ? 0
    : run(
        'node_modules/.bin/mocha',
        mocha([bundle], screensOnly ? 'spec' : 'dot', [
          '-r',
          './scripts/unitTierGuard.cjs',
          '--grep',
          slowUnderCoverage,
          '--invert'
        ]),
        { ...process.env, ...UNIT_SERVERS, NODE_V8_COVERAGE: temp }
      )
const tests = server || app
if (screensOnly) process.exit(tests)
const coverage = run('node_modules/.bin/c8', [
  'report',
  '--reporter=text',
  '--reporter=json',
  '--reports-dir',
  report,
  '--temp-directory',
  temp,
  ...[...required, ...edited].flatMap(file => ['--include', file]),
  '--exclude-after-remap'
])

// Each required file, whole.
const final = JSON.parse(
  readFileSync(resolve(report, 'coverage-final.json'), 'utf8')
)
let whole = 0
for (const file of required) {
  const entry = Object.entries(final).find(
    ([path]) => relative(process.cwd(), path) === file
  )?.[1]
  const lines = new Map()
  for (const [id, hits] of Object.entries(entry?.s ?? {})) {
    const line = entry.statementMap[id].start.line
    lines.set(line, (lines.get(line) ?? 0) + hits)
  }
  const covered = [...lines.values()].filter(hits => hits > 0).length
  const percent = lines.size === 0 ? 0 : (100 * covered) / lines.size
  console.log(`${file}: ${percent.toFixed(1)}% of ${lines.size} lines`)
  if (percent < 95) whole = 1
}

const gate = (files, min) =>
  files.length === 0
    ? 0
    : run('node', [
        'scripts/changed-line-check.cjs',
        '--base',
        base,
        '--coverage',
        resolve(report, 'coverage-final.json'),
        '--report',
        resolve(report, `changed-${min}.json`),
        '--min',
        String(min),
        '--ext',
        '.ts',
        '--ext',
        '.tsx',
        ...files
      ])
const ninetyFive = gate(edited, 95)
process.exit(tests || coverage || whole || ninetyFive)
