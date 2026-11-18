import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { build } from 'esbuild'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { UNIT_SERVERS } from './testTiers.mjs'
import { webSettings } from './web-build-settings.mjs'

// Line coverage of the people lists and account affiliations work, from the
// suites that exercise it. Each file the work adds or rewrites must have 90%
// of its lines covered; every other file it edits is held to 90% of the lines
// it changes, read from `TS_COVERAGE_BASE` (origin/develop unless given) to
// HEAD, so the gate runs after the commit. `--screens` runs only the app
// suites, with no database and no gate.
const base = process.env.TS_COVERAGE_BASE ?? 'origin/develop'
const screensOnly = process.argv.includes('--screens')
const specs = [
  // M1: a season's and a league's people leave out players.
  'src/server/routes/people.integration.test.ts',
  'src/server/teams/teamRoster.integration.test.ts',
  'src/server/groups/noticePolicy.integration.test.ts',
  'src/server/scoring/gumboIds.integration.test.ts',
  'src/server/groups/playerNamePrivacyReads.integration.test.ts',
  'src/server/routes/players.integration.test.ts',
  // M2: GET /me/affiliations.
  'src/server/users/accountAffiliations.integration.test.ts',
  'src/server/routes/me.integration.test.ts',
  'src/server/openapi.test.ts',
  'src/common/api.test.ts',
  // Add Admin's address.
  'src/app/navigation/routes.test.ts'
]
// `.tsx` specs run from one bundle, with the web's `react-native`.
const screens = [
  // M1 and M3: the people sections and their adds.
  'src/app/components/peopleAdds.test.tsx',
  'src/app/screens/teamRoster.test.tsx',
  'src/app/screens/TeamScreen.test.tsx',
  'src/app/screens/TeamPage.test.tsx',
  'src/app/screens/LeaguePage.test.tsx',
  'src/app/screens/SeasonPage.test.tsx',
  'src/app/screens/SeasonPresentation.test.tsx',
  'src/app/App.teamRoutes.test.tsx',
  // M4: Affiliations on the account screen.
  'src/app/components/AffiliationList.test.tsx',
  'src/app/screens/AccountScreen.test.tsx'
].filter(
  file =>
    existsSync(file) &&
    (process.env.TS_PEOPLE_SCREENS == null ||
      process.env.TS_PEOPLE_SCREENS.split(',').some(part =>
        file.includes(part)
      ))
)
// Account settings' slide-to-delete drags are timed against the wall clock,
// which coverage slows past what they allow; they run in npm test.
const slowUnderCoverage = 'Account settings screen .*(behind a slide|deleted)'
// Added or rewritten whole: 90% of every line.
const required = [
  'src/server/users/accountAffiliations.ts',
  'src/app/components/AffiliationList.tsx',
  'src/app/components/PeopleList.tsx',
  'src/app/screens/LevelPeopleTab.tsx'
].filter(file => existsSync(file))
// Edited: 90% of the lines the branch changes.
const edited = [
  'src/server/teams/teamRoster.ts',
  'src/server/routes/me.ts',
  'src/server/openapi.ts',
  'src/common/api.ts',
  'src/app/components/SectionHeader.tsx',
  'src/app/screens/TeamScreen.tsx',
  'src/app/screens/TeamPage.tsx',
  'src/app/screens/AccountScreen.tsx',
  'src/app/screens/GroupScreen.tsx',
  'src/app/screens/LeaguePage.tsx',
  'src/app/screens/SeasonPresentation.tsx',
  'src/app/App.tsx',
  'src/app/navigation/routes.ts',
  'src/app/screens/AddPeopleScreen.tsx',
  'src/app/screens/GroupPeoplePage.tsx',
  'src/app/components/RoleSwitches.tsx'
]

if (!screensOnly) {
  const database = spawnSync('node', ['src/migrate/requirePostgres18.js'], {
    stdio: 'inherit'
  })
  if (database.status !== 0) process.exit(1)
}
const report = resolve('coverage/peopleAffiliations')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

const bundle = 'lib/people-affiliations-tests.cjs'
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
      ...screens.map(file => `describe('', () => {\n  require('./${file}')\n})`)
    ].join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'people-affiliations-tests.ts'
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
const app = run(
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
  if (percent < 90) whole = 1
}

const gate = run('node', [
  'scripts/changed-line-check.cjs',
  '--base',
  base,
  '--coverage',
  resolve(report, 'coverage-final.json'),
  '--report',
  resolve(report, 'changed-90.json'),
  '--min',
  '90',
  '--ext',
  '.ts',
  '--ext',
  '.tsx',
  ...edited
])
process.exit(tests || coverage || whole || gate)
