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

const directory = 'coverage/chatUi'
const temp = `${directory}/tmp`
const base = process.env.TS_COVERAGE_BASE
if (base == null || base === '') throw new Error('TS_COVERAGE_BASE is required')
rmSync(directory, { recursive: true, force: true })
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
  stdin: {
    contents: [
      ...globSync('src/app/chat/**/*.test.tsx'),
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
  'src/server/socket/chatFanout.test.ts',
  'src/server/socket/gameSocket.test.ts',
  'src/server/socket/fanout.test.ts',
  'src/common/api.test.ts',
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
