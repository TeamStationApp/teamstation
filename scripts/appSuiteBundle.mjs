// One app suite (`.test.tsx`, or a `.test.ts` that needs the web build's
// resolution) bundled alone for Node, as the web build resolves it: the
// react-native → react-native-web alias, the native stubs, and the packages
// Node loads itself left out. Used by the coverage gates and test runners
// that run suites one per process.
import { build } from 'esbuild'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import { webSettings } from './web-build-settings.mjs'

export async function bundleAppSuite({ path, outfile, sourcefile }) {
  await build({
    ...webSettings,
    alias: {
      ...webSettings.alias,
      'react-native-webview': './src/test/eventWebViewStub.tsx',
      'react-native-maps': './src/test/eventNativeMapStub.tsx',
      '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts',
      '@react-native/assets-registry/registry':
        'react-native-web/dist/modules/AssetRegistry'
    },
    stdin: {
      contents: `import './${path}'`,
      resolveDir: process.cwd(),
      sourcefile
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: true,
    jsx: 'automatic',
    external: [
      'react',
      'react-dom',
      'three',
      '@react-three/fiber',
      '@react-three/test-renderer',
      'jsdom',
      'mocha',
      'chai',
      // Its Node build finds its own WebAssembly by import.meta.url, which a
      // CommonJS bundle empties: it is required at run time instead.
      '@sqlite.org/sqlite-wasm'
    ],
    define: {
      __DEV__: 'true',
      TS_API_BASE_URL: JSON.stringify('/api/v1'),
      'process.env.TS_SENTRY_DSN': JSON.stringify(''),
      'process.env.NODE_ENV': JSON.stringify('test')
    },
    loader: ASSET_LOADER
  })
}
