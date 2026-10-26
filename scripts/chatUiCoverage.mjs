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
import { takeCoverage } from 'node:v8'

import { build } from 'esbuild'

import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

const directory = process.env.TS_CHAT_COVERAGE_DIR ?? 'coverage/chatUi'
const temp = `${directory}/tmp`
const base = process.env.TS_COVERAGE_BASE
if (base == null || base === '') throw new Error('TS_COVERAGE_BASE is required')
if (process.env.TS_CHAT_COVERAGE_DIR == null)
  rmSync(directory, { recursive: true, force: true })
else mkdirSync(directory, { recursive: true })
mkdirSync(temp, { recursive: true })
function run(command, args) {
  console.log(`$ ${command} ${args.map(arg => JSON.stringify(arg)).join(' ')}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, NODE_V8_COVERAGE: resolve(temp) }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run('node', ['scripts/chatCryptoBuild.mjs', 'node', 'wasm'])
await build({
  ...webSettings,
  alias: {
    ...webSettings.alias,
    'react-native-svg': './src/test/umpireSvgStub.tsx'
  },
  stdin: {
    contents: [
      ...globSync('src/app/chat/**/*.test.tsx'),
      ...globSync('src/app/App.offline*.test.tsx'),
      'src/app/App.navbarPop.test.tsx',
      'src/app/App.tess.test.tsx',
      'src/app/dev/ChatBenchScreen.test.tsx',
      'src/app/components/GuardiansModal.test.tsx',
      'src/app/screens/ChatReportsScreen.test.tsx',
      'src/app/screens/TeamScreen.test.tsx',
      'src/app/screens/PlayerSettingsTab.test.tsx',
      'src/app/screens/JoinScreen.test.tsx',
      'src/app/screens/SeasonPresentation.test.tsx',
      'src/app/screens/FollowTeamScreen.test.tsx',
      'src/app/umpires/appMask.test.tsx',
      'src/app/umpires/routes.test.tsx',
      'src/app/umpires/noteEditor.test.tsx',
      'src/app/components/Emblem.test.tsx',
      'src/app/components/GlassView.test.tsx',
      'src/app/components/AppNav.test.tsx'
    ]
      .map(path => `import './${path}'`)
      .join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'chat-ui-test-entry.ts'
  },
  outfile: `${directory}/tests.cjs`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
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
  plugins: [...webSettings.plugins, chatCoreResolvePlugin()],
  define: {
    __DEV__: 'true',
    TS_CHAT_NODE_ADDON: JSON.stringify(
      resolve('src/common/chatCrypto/node/chat_crypto.node')
    ),
    TS_API_BASE_URL: JSON.stringify('/api/v1'),
    'process.env.NODE_ENV': JSON.stringify('test')
  },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
})
const specs = [
  ...globSync('src/app/chat/**/*.test.ts'),
  ...globSync('src/server/chat/*.test.ts'),
  ...globSync('src/server/routes/chat*.test.ts'),
  ...globSync('src/migrate/chat*.test.ts'),
  ...globSync('src/common/chatCrypto/*.test.ts'),
  'src/app/dev/chatIdentityStoreProbe.test.ts',
  'src/app/dev/chatBenchRun.test.ts',
  'src/migrate/migrations/057chatMasterCompatibility.test.ts',
  'src/migrate/migrations/068chatUserIdBridge.test.ts',
  'src/migrate/migrations/068gumboIds.test.ts',
  'src/migrate/migrations/069userIds.test.ts',
  'src/migrate/migrations/075chatCanonicalUserIds.test.ts',
  'src/migrate/runner.test.ts',
  'src/common/userId.test.ts',
  'src/server/users/mintUserId.test.ts',
  'src/server/scoring/gumboIds.test.ts',
  'src/server/access.test.ts',
  'src/server/teams/teamRoster.test.ts',
  'src/server/admin/people.test.ts',
  'src/server/admin/closeIntoSignIns.test.ts',
  'src/server/routes/follows.test.ts',
  'src/server/routes/guardians.test.ts',
  'src/server/routes/invites.test.ts',
  'src/server/groups/follows.test.ts',
  'src/server/socket/syncRevision.test.ts',
  'src/test/chat2FixtureIdentity.test.ts',
  'src/test/llvmChangedLineCounts.test.ts',
  'src/server/socket/chatFanout.test.ts',
  'src/server/socket/gameSocket.test.ts',
  'src/server/socket/fanout.test.ts',
  'src/common/api.test.ts',
  'src/common/age.test.ts',
  'src/app/scoring/microphone.test.ts',
  'src/app/components/iconFont.test.ts',
  'src/server/media/images.test.ts',
  'src/server/media/mediaOrigins.test.ts',
  'src/server/dev/fakeSpace.test.ts',
  'src/server/tess/sitemap.test.ts',
  'src/buildCsp.test.ts',
  'src/common/chatContent.test.ts',
  'src/app/components/teamTile.test.ts',
  'src/app/navigation/routes.test.ts',
  'src/common/gameSocket.test.ts',
  'src/server/openapi.test.ts',
  'src/test/nativeBabel.test.ts',
  'src/test/changedLineCoverage.test.ts',
  'src/test/coverageScripts.test.ts',
  `${directory}/tests.cjs`
]
run('node_modules/.bin/mocha', [
  '-r',
  'sucrase/register',
  '-r',
  './src/test/scoringDomSetup.cjs',
  '--timeout',
  '180000',
  '--exit',
  ...specs
])
takeCoverage()
for (const file of readdirSync(temp)) {
  const path = resolve(temp, file)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {})) {
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  }
  writeFileSync(path, JSON.stringify(data))
}
