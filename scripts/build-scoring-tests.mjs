import { globSync, mkdirSync } from 'node:fs'

import { build } from 'esbuild'

import { webSettings } from './web-build-settings.mjs'

mkdirSync('lib', { recursive: true })
const files = globSync('src2/**/*.test.tsx')
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
  define: {
    __DEV__: 'true',
    GS_API_BASE_URL: JSON.stringify('/api/v1'),
    'process.env.NODE_ENV': JSON.stringify('test')
  },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
})
