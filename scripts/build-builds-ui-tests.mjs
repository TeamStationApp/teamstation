import { mkdirSync } from 'node:fs'

import { build } from 'esbuild'

import { webSettings } from './web-build-settings.mjs'
const suites = [
  'src/app/screens/OAuthScreen.test.tsx',
  'src/app/oauth/approvalClient.test.ts'
]
mkdirSync('lib', { recursive: true })
await build({
  ...webSettings,
  stdin: {
    contents: suites.map(file => `import './${file}'`).join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'builds-test-entry.ts'
  },
  outfile: 'lib/builds-tests.cjs',
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
