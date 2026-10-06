import { spawnSync } from 'node:child_process'
import {
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

const suites = [
  'src/app/scoreboard/scoreGameEntry.test.tsx',
  'src/app/screens/AccountScreen.test.tsx',
  'src/app/platform/pickAccountPhoto.test.tsx',
  'src/app/walkup/useSongPlayer.test.tsx',
  'src/app/screens/fullName.test.tsx',
  'src/app/screens/PlayerScreen.test.tsx'
]
const required = [
  'src/common/passwordProtocol.ts',
  'src/server/auth/passwords.ts',
  'src/server/account/passwordReset.ts',
  'src/app/platform/passwordKdfNative.ts',
  'src/app/platform/passwordKdf.ts',
  'src/app/platform/passwordWorker.ts',
  'src/common/accountSettings.ts',
  'src/server/routes/account.ts',
  'src/server/account/emails.ts',
  'src/app/screens/AccountScreen.tsx',
  'src/app/platform/pickAccountPhoto.ts',
  'src/app/platform/accountPhotoNative.ts'
]
const reportDir = resolve('coverage/account')
const temp = resolve(reportDir, 'tmp')
rmSync(reportDir, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
mkdirSync('lib', { recursive: true })
await build({
  ...webSettings,
  stdin: {
    contents: suites.map(file => `import './${file}'`).join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'account-test-entry.ts'
  },
  outfile: 'lib/account-tests.cjs',
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
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
})
const env = { ...process.env, NODE_V8_COVERAGE: temp }
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run('node_modules/.bin/mocha', [
  '-r',
  'sucrase/register',
  '-r',
  './src/test/scoringDomSetup.cjs',
  'src/server/routes/account.test.ts',
  'src/server/routes/password.test.ts',
  'src/server/auth/passwords.test.ts',
  'src/common/passwordProtocol.test.ts',
  'src/common/passwordClient.test.ts',
  'src/app/platform/passwordKdf.test.ts',
  'src/app/platform/accountPhoto.test.ts',
  'src/server/openapi.test.ts',
  'src/server/jsonBody.test.ts',
  'src/common/api.test.ts',
  'lib/account-tests.cjs'
])
for (const file of readdirSync(temp)) {
  const location = resolve(temp, file)
  const data = JSON.parse(readFileSync(location, 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {})) {
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  }
  writeFileSync(location, JSON.stringify(data))
}
run('node_modules/.bin/c8', [
  'report',
  '--reporter=text',
  '--reporter=json',
  '--reporter=json-summary',
  '--reports-dir',
  reportDir,
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.e2e.*',
  '--exclude',
  'src/test/**',
  '--exclude-after-remap',
  ...[
    ...required,
    'src/common/api.ts',
    'src/server/routes/auth.ts',
    'src/server/jsonBody.ts',
    'src/server/openapi.ts',
    'src/app/App.tsx',
    'src/app/components/AppHeader.tsx'
  ].flatMap(file => ['--include', file])
])
const summary = JSON.parse(
  readFileSync(resolve(reportDir, 'coverage-summary.json'), 'utf8')
)
for (const file of required) {
  const count = summary[resolve(file)]?.lines
  if (count == null || count.total === 0 || count.pct < 90)
    throw new Error(
      `${file}: expected mapped line coverage >= 90%, got ${JSON.stringify(count)}`
    )
}
run('node', [
  'scripts/changed-line-check.cjs',
  '--coverage',
  resolve(reportDir, 'coverage-final.json'),
  '--ext',
  '.ts',
  '--ext',
  '.tsx',
  // Only import-and-call wiring; native adapter behavior is covered above.
  '--exclude',
  'src/app/platform/pickAccountPhoto.native.ts',
  '--exclude',
  'src/app/platform/passwordKdf.native.ts',
  // Bootstrap depends on live services; tested by builds and the real HTTP e2e harness.
  '--exclude',
  'src/server/index.ts',
  '--exclude',
  'src/test',
  '--allow-empty',
  'src/app',
  'src/common',
  'src/server'
])
