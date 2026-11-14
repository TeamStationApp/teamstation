import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { takeCoverage } from 'node:v8'

import { build } from 'esbuild'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

const directory = 'coverage/declaredAge'
const temp = `${directory}/tmp`
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

const specs = [
  'src/app/chat/declaredAgeGate.test.tsx',
  'src/app/chat/ChatAgeGate.test.tsx',
  'src/app/App.chatAge.test.tsx',
  'src/app/components/AppNav.test.tsx',
  'src/app/chat/PersonMessageButton.test.tsx',
  'src/app/chat/entityChats.test.tsx',
  'src/app/chat/chatUi.test.tsx',
  'src/app/screens/TeamScreen.test.tsx',
  'src/app/screens/SeasonPresentation.test.tsx',
  'src/app/screens/LeaguePage.test.tsx',
  'src/app/screens/PlayerScreen.test.tsx',
  'src/app/screens/AccountScreen.test.tsx',
  'src/app/App.entityChats.test.tsx',
  'src/app/chat/chatScreens.test.tsx'
]

await build({
  ...webSettings,
  alias: {
    ...webSettings.alias,
    'react-native-svg': './src/test/umpireSvgStub.tsx'
  },
  stdin: {
    contents: specs.map(path => `import './${path}'`).join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'declared-age-test-entry.ts'
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
    TS_DECLARED_AGE_LOWER: JSON.stringify(''),
    TS_API_BASE_URL: JSON.stringify('/api/v1'),
    'process.env.NODE_ENV': JSON.stringify('test')
  },
  loader: ASSET_LOADER
})

run('node_modules/.bin/mocha', [
  '-r',
  'sucrase/register',
  '-r',
  './src/test/scoringDomSetup.cjs',
  '--timeout',
  '20000',
  '--exit',
  `${directory}/tests.cjs`,
  'src/app/chat/declaredAge.test.ts'
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
