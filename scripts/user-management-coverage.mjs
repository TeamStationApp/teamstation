// The coverage gate of node administration's User Management.
//
//   node scripts/user-management-coverage.mjs [--unit]
//
// The unit pass runs the unit suites, and the app's suites bundled as the
// unit tier bundles them, and holds the files of new pure logic at 90% of
// their lines. The combined pass adds the integration suites and the
// browser end-to-end run's coverage (`coverage/userManagement/browser.json`,
// which `src/app/userManagement.e2e.ts` writes from the same revision), and
// holds every changed production line on the branch, file by file and in
// all, at 95% (`changed-line-check.cjs`). `--unit` runs the unit pass alone.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
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

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

const appSuites = [
  'src/app/screens/UserManagementScreen.test.tsx',
  'src/app/screens/NodeAdministrationScreen.test.tsx',
  'src/app/screens/AdminAccountScreen.test.tsx',
  'src/app/components/PersonSearchRow.test.tsx',
  'src/app/screens/peopleAccounts.test.tsx',
  'src/app/umpires/management.test.tsx'
]
const unitSuites = [
  'src/server/admin/deviceLabels.test.ts',
  'src/server/admin/activityCursor.test.ts',
  'src/server/admin/userDirectory.test.ts',
  'src/server/tess/denyList.test.ts',
  'src/server/openapi.test.ts',
  'src/common/userManagement.test.ts',
  'src/common/api.userManagement.test.ts',
  'src/app/chat/thisDevice.test.ts',
  'src/app/navigation/routes.test.ts'
]
const integrationSuites = [
  'src/server/auth/deviceSessions.integration.test.ts',
  'src/server/admin/userActivity.integration.test.ts',
  'src/server/admin/userDirectory.integration.test.ts',
  'src/server/admin/nodeAdministration.integration.test.ts',
  'src/server/routes/appSignIn.integration.test.ts',
  'src/server/routes/password.integration.test.ts',
  'src/server/routes/account.integration.test.ts',
  'src/server/routes/pictures.integration.test.ts',
  'src/migrate/runner.integration.test.ts',
  'src/server/tess/sitemap.integration.test.ts'
]
/** Files of new logic that unit tests alone hold at 90%. */
const unitRequired = [
  'src/server/admin/deviceLabels.ts',
  'src/server/admin/activityCursor.ts',
  'src/common/userManagement.ts',
  'src/app/screens/UserManagementScreen.tsx',
  'src/app/screens/userManagementRows.tsx'
]
/** `affiliationRoles`, the pure part of `userDirectory.ts`, by its lines. */
const affiliationRoles = 'src/server/admin/userDirectory.ts'

const unitOnly = process.argv.includes('--unit')
const reportDir = resolve('coverage/userManagement')
const unitTemp = resolve(reportDir, 'unit-v8')
const integrationTemp = resolve(reportDir, 'integration-v8')
const browser = resolve(reportDir, 'browser.json')
for (const dir of [unitTemp, integrationTemp, resolve(reportDir, 'unit')])
  rmSync(dir, { recursive: true, force: true })
mkdirSync(unitTemp, { recursive: true })
mkdirSync(integrationTemp, { recursive: true })
mkdirSync('lib', { recursive: true })

await build({
  ...webSettings,
  plugins: [...webSettings.plugins, pagedListStandInPlugin()],
  stdin: {
    contents: appSuites.map(file => `import './${file}'`).join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'user-management-test-entry.ts'
  },
  outfile: 'lib/user-management-tests.cjs',
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
    TS_API_BASE_URL: JSON.stringify('/api/v1'),
    'process.env.NODE_ENV': JSON.stringify('test')
  },
  loader: ASSET_LOADER
})

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const mocha = [
  '--exit',
  '--timeout',
  '60000',
  '-r',
  'sucrase/register',
  '-r',
  './src/test/scoringDomSetup.cjs',
  '--extension',
  'ts'
]

/** Source maps written as file URLs read as the paths c8 matches on. */
function plainSources(dir) {
  for (const file of readdirSync(dir)) {
    const location = resolve(dir, file)
    const data = JSON.parse(readFileSync(location, 'utf8'))
    for (const map of Object.values(data['source-map-cache'] ?? {}))
      if (map.data?.sources != null)
        map.data.sources = map.data.sources.map(source =>
          source.startsWith('file://') ? fileURLToPath(source) : source
        )
    writeFileSync(location, JSON.stringify(data))
  }
}

function report(tempDir, out) {
  run('node_modules/.bin/c8', [
    'report',
    '--temp-directory',
    tempDir,
    '--reporter=text-summary',
    '--reporter=json',
    '--reporter=json-summary',
    '--reports-dir',
    out,
    '--exclude',
    '**/*.test.*',
    '--exclude',
    '**/*.integration.*',
    '--exclude',
    '**/*.e2e.*',
    '--exclude',
    'src/test/**',
    '--exclude',
    'lib/**',
    '--exclude-after-remap',
    '--include',
    'src/**'
  ])
}

// The unit pass.
run(
  'node_modules/mocha/bin/mocha.js',
  [...mocha, ...unitSuites, 'lib/user-management-tests.cjs'],
  {
    NODE_V8_COVERAGE: unitTemp,
    TS_TEST_DATABASE_URL: 'postgres://unit-tests-have-no-database.invalid/x',
    TS_TEST_REDIS_URL: 'redis://unit-tests-have-no-redis.invalid:6379'
  }
)
plainSources(unitTemp)
report(unitTemp, resolve(reportDir, 'unit'))
const unit = JSON.parse(
  readFileSync(resolve(reportDir, 'unit', 'coverage-summary.json'), 'utf8')
)
const short = []
for (const file of unitRequired) {
  const lines = unit[resolve(file)]?.lines
  console.log(`unit ${file}: ${lines?.pct ?? 0}% of ${lines?.total ?? 0} lines`)
  if (lines == null || lines.total === 0 || lines.pct < 90) short.push(file)
}
// `affiliationRoles` alone: the rest of its file is SQL, held below.
const final = JSON.parse(
  readFileSync(resolve(reportDir, 'unit', 'coverage-final.json'), 'utf8')
)[resolve(affiliationRoles)]
const roles = Object.entries(final?.fnMap ?? {}).find(
  ([, fn]) => fn.name === 'affiliationRoles'
)
if (roles == null) short.push(`${affiliationRoles} affiliationRoles`)
else {
  const [id, fn] = roles
  const inside = Object.entries(final.statementMap).filter(
    ([, at]) =>
      at.start.line >= fn.loc.start.line && at.end.line <= fn.loc.end.line
  )
  const hit = inside.filter(([key]) => final.s[key] > 0).length
  const pct = inside.length === 0 ? 0 : (hit / inside.length) * 100
  console.log(
    `unit ${affiliationRoles} affiliationRoles: ${pct.toFixed(1)}% of ${inside.length} statements (called ${final.f[id]} times)`
  )
  if (pct < 90) short.push(`${affiliationRoles} affiliationRoles`)
}
if (short.length > 0) {
  console.error(`Unit coverage under 90%: ${short.join(', ')}`)
  process.exit(1)
}
if (unitOnly) process.exit(0)

// The combined pass: the unit run's counters, the integration suites', and
// the browser's, from the same revision.
run('node_modules/mocha/bin/mocha.js', [...mocha, ...integrationSuites], {
  NODE_V8_COVERAGE: integrationTemp
})
plainSources(integrationTemp)
for (const file of readdirSync(unitTemp))
  writeFileSync(
    resolve(integrationTemp, `unit-${file}`),
    readFileSync(resolve(unitTemp, file))
  )
report(integrationTemp, resolve(reportDir, 'combined'))
const require = createRequire(resolve('package.json'))
const { createCoverageMap } = require('istanbul-lib-coverage')
const merged = createCoverageMap(
  JSON.parse(
    readFileSync(resolve(reportDir, 'combined', 'coverage-final.json'), 'utf8')
  )
)
if (!existsSync(browser)) {
  console.error(
    `${browser} is missing: run the browser end-to-end test (src/app/userManagement.e2e.ts) first`
  )
  process.exit(1)
}
merged.merge(JSON.parse(readFileSync(browser, 'utf8')))
const mergedFile = resolve(reportDir, 'merged-final.json')
writeFileSync(mergedFile, JSON.stringify(merged.toJSON()))
run('node', [
  'scripts/changed-line-check.cjs',
  '--base',
  process.env.TS_COVERAGE_BASE ?? 'origin/develop',
  '--coverage',
  mergedFile,
  '--report',
  resolve(reportDir, 'changed-lines.json'),
  '--min',
  '95',
  '--ext',
  '.ts',
  '--ext',
  '.tsx',
  // Generated, or a type the compiler checks and nothing runs.
  '--exclude',
  'src/server/tess/sitemap.generated.json',
  '--exclude',
  'src/server/db/database.ts',
  '--exclude',
  'src/test',
  'src',
  'scripts/user-management-coverage.mjs'
])
