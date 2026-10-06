import { globSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { build } from 'esbuild'

import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

mkdirSync('lib', { recursive: true })
const files = globSync('src/**/*.test.tsx')
await build({
  ...webSettings,
  stdin: {
    contents: files.map(file => `import './${file}'`).join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'scoring-test-entry.ts'
  },
  outfile: 'lib/scoring-tests.cjs',
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
  // The bundle runs in Node: the chat crypto core is the Node addon's.
  plugins: [...(webSettings.plugins ?? []), chatCoreResolvePlugin()],
  define: {
    __DEV__: 'true',
    TS_CHAT_NODE_ADDON: JSON.stringify(
      resolve('src/common/chatCrypto/node/chat_crypto.node')
    ),
    TS_API_BASE_URL: JSON.stringify('/api/v1'),
    // Tests never report; they hand startSentry a DSN and an SDK of their own.
    'process.env.TS_SENTRY_DSN': JSON.stringify(''),
    'process.env.NODE_ENV': JSON.stringify('test')
  },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
})
