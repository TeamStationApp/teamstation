import { globSync, mkdirSync } from 'node:fs'

import { build } from 'esbuild'

import { webSettings } from './web-build-settings.mjs'

mkdirSync('lib', { recursive: true })
const currentSetup = process.argv.includes('--current-setup')
const files = currentSetup
  ? globSync(['src/app/scoring/*.test.tsx', 'src/app/field/*.test.tsx'])
  : globSync('src/**/*.test.tsx')
await build({
  ...webSettings,
  // Native SVG adapter tests use the package's web renderer and web asset registry.
  alias: {
    ...webSettings.alias,
    '@react-native/assets-registry/registry':
      'react-native-web/dist/modules/AssetRegistry'
  },
  stdin: {
    contents: files.map(file => `import './${file}'`).join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'scoring-test-entry.ts'
  },
  outfile: currentSetup
    ? 'lib/current-setup-tests.cjs'
    : 'lib/scoring-tests.cjs',
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
    // Tests never report; they hand startSentry a DSN and an SDK of their own.
    'process.env.TS_SENTRY_DSN': JSON.stringify(''),
    'process.env.NODE_ENV': JSON.stringify('test')
  },
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
})
