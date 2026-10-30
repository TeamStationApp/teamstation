import { globSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { build } from 'esbuild'

import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

mkdirSync('lib', { recursive: true })
const currentSetup = process.argv.includes('--current-setup')
const rosterEdit = process.argv.includes('--roster-edit')
const files = currentSetup
  ? globSync(['src/app/scoring/*.test.tsx', 'src/app/field/*.test.tsx'])
  : globSync('src/**/*.test.tsx')
const extraFiles = rosterEdit
  ? globSync([
      'src/app/App*.test.tsx',
      'src/app/navigation/*.test.tsx',
      'src/app/screens/PlayerScreen.test.tsx',
      'src/app/screens/PlayerSettingsTab.test.tsx',
      'src/app/screens/fullName.test.tsx'
    ])
  : []
const entries = [
  {
    files,
    outfile: currentSetup
      ? 'lib/current-setup-tests.cjs'
      : 'lib/scoring-tests.cjs'
  },
  ...extraFiles.map((file, index) => ({
    files: [file],
    outfile: `lib/roster-edit-${index}-tests.cjs`
  }))
]
for (const entry of entries)
  await build({
    ...webSettings,
    plugins: [
      ...webSettings.plugins,
      chatCoreResolvePlugin(),
      pagedListStandInPlugin(),
      {
        name: 'native-initials-measurement-unit',
        setup(build) {
          build.onLoad({ filter: /FittedInitials\.native\.tsx$/ }, args => ({
            contents: readFileSync(args.path, 'utf8').replace(
              "from 'react-native'",
              "from '../../test/nativeInitialsTextStub'"
            ),
            loader: 'tsx'
          }))
        }
      }
    ],
    // Native SVG adapter tests use the package's web renderer and web asset registry.
    alias: {
      ...webSettings.alias,
      'react-native-webview': './src/test/eventWebViewStub.tsx',
      'react-native-maps': './src/test/eventNativeMapStub.tsx',
      '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts',
      '@react-native-community/geolocation': './src/test/geolocationStub.ts',
      '@react-native/assets-registry/registry':
        'react-native-web/dist/modules/AssetRegistry'
    },
    stdin: {
      contents: entry.files.map(file => `import './${file}'`).join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'scoring-test-entry.ts'
    },
    outfile: entry.outfile,
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
