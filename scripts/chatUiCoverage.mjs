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

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
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
      'src/app/App.entityChats.test.tsx',
      'src/app/App.chatAge.test.tsx',
      'src/app/App.scoringRosterEdit.integration.test.tsx',
      'src/app/screens/LeaguePage.test.tsx',
      'src/app/screens/PlayerScreen.test.tsx',
      'src/app/screens/AccountScreen.test.tsx',
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
      'src/app/components/AppNav.test.tsx',
      'src/app/screens/NotificationsScreen.test.tsx',
      'src/app/components/AppHeader.test.tsx',
      'src/app/components/SuccessToast.test.tsx',
      'src/app/screens/OAuthScreen.test.tsx'
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
  plugins: [
    ...webSettings.plugins,
    chatCoreResolvePlugin(),
    pagedListStandInPlugin()
  ],
  define: {
    __DEV__: 'true',
    TS_CHAT_NODE_ADDON: JSON.stringify(
      resolve('src/common/chatCrypto/node/chat_crypto.node')
    ),
    TS_API_BASE_URL: JSON.stringify('/api/v1'),
    'process.env.NODE_ENV': JSON.stringify('test')
  },
  loader: ASSET_LOADER
})
const specs = [
  ...globSync('src/app/chat/**/*.test.ts'),
  ...globSync('src/server/chat/*.test.ts'),
  ...globSync('src/server/notifications/*.test.ts'),
  ...globSync('src/server/routes/chat*.test.ts'),
  'src/server/routes/account.chatAge.integration.test.ts',
  ...globSync('src/migrate/chat*.test.ts'),
  ...globSync('src/common/chatCrypto/*.test.ts'),
  'src/app/dev/chatIdentityStoreProbe.test.ts',
  'src/app/dev/chatBenchRun.test.ts',
  'src/migrate/migrations/057chatMasterCompatibility.integration.test.ts',
  'src/migrate/migrations/068chatUserIdBridge.integration.test.ts',
  'src/migrate/migrations/068gumboIds.integration.test.ts',
  'src/migrate/migrations/069userIds.integration.test.ts',
  'src/migrate/migrations/075chatCanonicalUserIds.integration.test.ts',
  'src/migrate/runner.integration.test.ts',
  'src/common/userId.test.ts',
  'src/server/users/mintUserId.test.ts',
  'src/server/scoring/gumboIds.integration.test.ts',
  'src/server/access.integration.test.ts',
  'src/server/teams/teamRoster.integration.test.ts',
  'src/server/admin/people.integration.test.ts',
  'src/server/admin/closeIntoSignIns.integration.test.ts',
  'src/server/routes/follows.integration.test.ts',
  'src/server/routes/guardians.integration.test.ts',
  'src/server/routes/invites.integration.test.ts',
  'src/server/groups/follows.integration.test.ts',
  'src/server/socket/syncRevision.integration.test.ts',
  'src/test/chat2FixtureIdentity.integration.test.ts',
  'src/test/llvmChangedLineCounts.integration.test.ts',
  'src/server/socket/chatFanout.integration.test.ts',
  'src/server/serverStart.integration.test.ts',
  'src/server/chatHistoryWiring.test.ts',
  'src/server/socket/gameSocket.integration.test.ts',
  'src/server/socket/fanout.integration.test.ts',
  'src/common/api.test.ts',
  'src/common/age.test.ts',
  'src/app/scoring/microphone.test.ts',
  'src/app/components/iconFont.test.ts',
  'src/server/media/images.integration.test.ts',
  'src/server/media/mediaOrigins.integration.test.ts',
  'src/server/dev/fakeSpace.test.ts',
  'src/server/tess/sitemap.integration.test.ts',
  'src/buildCsp.integration.test.ts',
  'src/common/chatContent.test.ts',
  'src/app/components/teamTile.test.ts',
  'src/app/navigation/routes.test.ts',
  'src/common/gameSocket.test.ts',
  'src/server/openapi.test.ts',
  'src/test/nativeBabel.integration.test.ts',
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
