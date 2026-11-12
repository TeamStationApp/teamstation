/** Bundles only in-process component tests for the unit-only recovery gate. */
import { globSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { build } from 'esbuild'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

const directory = process.argv[2]
if (!directory) throw new Error('Expected an output directory')
mkdirSync(directory, { recursive: true })
await build({
  ...webSettings,
  alias: {
    ...webSettings.alias,
    'react-native-svg': './src/test/umpireSvgStub.tsx'
  },
  stdin: {
    contents: globSync('src/app/chat/**/*.test.tsx')
      .map(path => `import './${path}'`)
      .join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'chat-history-unit-entry.ts'
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
