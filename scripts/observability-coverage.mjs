import { spawnSync } from 'node:child_process'
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { build } from 'esbuild'

import counters from './changed-line-coverage.cjs'
import gateModule from './observability-line-gate.cjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

const { snapshot, gate } = gateModule
const before = snapshot()
const directory = 'coverage/observability'
mkdirSync(directory, { recursive: true })
await build({
  ...webSettings,
  alias: {
    ...webSettings.alias,
    '@react-native/assets-registry/registry':
      'react-native-web/dist/modules/AssetRegistry'
  },
  plugins: [
    ...webSettings.plugins,
    pagedListStandInPlugin(),
    {
      name: 'native-sdk-host-test',
      setup(builder) {
        builder.onResolve({ filter: /^@sentry\/react-native$/ }, () => ({
          path: 'native-sdk-test',
          namespace: 'native-sdk-test'
        }))
        builder.onLoad({ filter: /.*/, namespace: 'native-sdk-test' }, () => ({
          contents:
            'export const addBreadcrumb = () => {}, captureException = () => {}, ErrorBoundary = () => {}, init = () => {}, nativeCrash = () => {}, setTag = () => {}, setUser = () => {}'
        }))
      }
    }
  ],
  stdin: {
    contents: [
      'src/app/sentry.test.tsx',
      'src/app/sentrySdk.native.test.tsx',
      'src/app/screens/OnboardingScreen.test.tsx',
      'src/app/App.offlineSession.test.tsx',
      'src/app/player/MultiCamView.test.tsx',
      'src/app/player/MultiCamView.native.test.tsx',
      'src/app/stream/StreamingScreen.test.tsx',
      'src/app/stream/CameraAnglesPanel.test.tsx',
      'src/app/stream/useResumePendingUploads.test.tsx',
      'src/app/screens/SignInLinkScreen.test.tsx',
      'src/app/screens/SignInLinkServer.test.tsx',
      ...globSync('src/app/observability/*.test.tsx')
    ]
      .map(file => `import './${file}'`)
      .join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'observability-tests.ts'
  },
  outfile: 'lib/observability-tests.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  jsx: 'automatic',
  external: ['react', 'react-dom', 'jsdom', 'mocha', 'chai'],
  sourcemap: true,
  define: {
    __DEV__: 'true',
    TS_API_BASE_URL: JSON.stringify('/api/v1'),
    'process.env.TS_SENTRY_DSN': '""',
    'process.env.TS_API_BASE_URL': '"https://app.example.test/api/v1"',
    'process.env.NODE_ENV': '"test"'
  },
  loader: { '.png': 'dataurl', '.svg': 'dataurl' }
})
const tests = [
  ...globSync('src/**/observability/*.test.ts'),
  ...globSync('src/logServer/*.test.ts'),
  'src/server/account/deleteAccount.test.ts',
  'src/server/jsonBody.test.ts',
  'src/server/middleware/withCors.test.ts',
  'src/server/serverConfig.test.ts',
  'src/server/openapi.test.ts',
  'src/server/sentry/sentry.test.ts',
  'src/server/statsBuilder/main.test.ts',
  'src/app/player/nativeVideoHandle.test.ts',
  'src/common/api.test.ts',
  'src/server/routes/signup.test.ts',
  'src/server/routes/directorUploads.test.ts',
  'lib/observability-tests.cjs',
  'scripts/observability-line-gate.test.cjs'
]
const include = [
  'src/common/observability/*.ts',
  'src/common/api.ts',
  'src/server/observability/*.ts',
  'src/logServer/*.ts',
  'scripts/observability-line-gate.cjs',
  'src/migrate/migrations/077analyticsEvents.ts',
  'src/migrate/migrations/index.ts',
  'src/server/account/deleteAccount.ts',
  'src/server/jsonBody.ts',
  'src/server/middleware/withCors.ts',
  'src/server/serverConfig.ts',
  'src/server/openapi.ts',
  'src/server/index.ts',
  'src/app/sentry.ts',
  'src/app/sentrySdk.native.ts',
  'src/app/observability/*.ts',
  'src/app/observability/*.tsx',
  'src/app/App.tsx',
  'src/app/screens/LoginScreen.tsx',
  'src/app/screens/OnboardingScreen.tsx',
  'src/app/screens/SignInLinkScreen.tsx',
  'src/app/stream/StreamingScreen.native.tsx',
  'src/app/stream/CameraAnglesPanel.native.tsx',
  'src/app/stream/useResumePendingUploads.ts',
  'src/server/routes/auth.ts',
  'src/server/routes/directorUploads.ts',
  'src/app/player/MultiCamView.tsx',
  'src/app/player/MultiCamView.native.tsx',
  'src/app/player/nativeVideoHandle.ts',
  'src/server/sentry/options.ts',
  'src/server/statsBuilder/main.ts',
  'src/server/statsBuilder/start.ts'
]
const args = [
  'node_modules/.bin/c8',
  '--all',
  '--reporter=text',
  '--reporter=json',
  '--report-dir',
  directory,
  ...include.flatMap(path => ['--include', path]),
  '--include',
  'lib/observability-tests.cjs',
  '--exclude',
  '**/*.test.*',
  'node',
  'node_modules/mocha/bin/mocha.js',
  '--timeout',
  '30000',
  '--exit',
  '-r',
  'sucrase/register',
  '-r',
  './src/test/scoringDomSetup.cjs',
  ...tests
]
console.log('$ node ' + args.join(' '))
const result = spawnSync('node', args, { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
const coverage = JSON.parse(
  readFileSync(resolve(directory, 'coverage-final.json'), 'utf8')
)
const counts = Object.fromEntries(
  Object.entries(coverage).map(([path, entry]) => [
    path,
    counters.istanbulCounts(entry)
  ])
)
const report = gate(
  before,
  counts,
  path =>
    /^src\/(common|server|app)\/observability\//.test(path) ||
    path.startsWith('src/logServer/') ||
    include.includes(path) ||
    path === 'scripts/observability-line-gate.cjs'
)
writeFileSync(
  resolve(directory, 'gate.json'),
  JSON.stringify({ stamp: before.stamp, report }, null, 2)
)
