import {
  globSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { resolve } from 'node:path'

import { build } from 'esbuild'

import { ASSET_LOADER } from '../src/esbuildLoaders.mjs'
import { chatCoreResolvePlugin } from './chatCoreResolvePlugin.mjs'
import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { appFiles, tierOf } from './testTiers.mjs'
import { webSettings } from './web-build-settings.mjs'

mkdirSync('lib', { recursive: true })
const currentSetup = process.argv.includes('--current-setup')
const rosterEdit = process.argv.includes('--roster-edit')
const chunkArgument = process.argv.find(arg => arg.startsWith('--chunk-bytes='))
const chunkBytes =
  chunkArgument == null
    ? 0
    : Number(chunkArgument.slice('--chunk-bytes='.length))
if (!Number.isInteger(chunkBytes) || chunkBytes < 0)
  throw new Error(`Expected --chunk-bytes=<bytes>, got ${chunkArgument}`)
const chunkDir =
  process.argv
    .find(arg => arg.startsWith('--chunk-dir='))
    ?.slice('--chunk-dir='.length) ?? 'lib'
const files = currentSetup
  ? globSync([
      'src/app/scoring/*.test.tsx',
      'src/app/field/*.test.tsx',
      'src/app/sync/*.test.tsx',
      'src/app/hooks/*.test.tsx',
      'src/app/screens/CoachGameScreen.test.tsx'
    ])
  : // `--tier=integration` bundles the app files that need a server; the default
    // is the unit tier's.
    appFiles(tierOf(process.argv.slice(2)))
const extraFiles = rosterEdit
  ? globSync([
      'src/app/App*.test.tsx',
      'src/app/navigation/*.test.tsx',
      'src/app/screens/PlayerScreen.test.tsx',
      'src/app/screens/PlayerSettingsTab.test.tsx',
      'src/app/screens/fullName.test.tsx'
    ])
  : []
/**
 * `--chunk-bytes=B` splits the files, in order of their paths, into bundles in
 * `--chunk-dir` (lib) of about B bytes of test source each, for
 * run-unit-tests.mjs to run in processes of their own. Each bundle is a run of
 * consecutive files, so every file follows only files that came before it in
 * a single bundle of them all. `scoring-tests-chunks.json` lists each bundle with its test files
 * and the bytes of test source in them.
 */
function chunked(maxBytes) {
  const bundles = []
  let bundle
  for (const file of [...files].sort()) {
    const bytes = statSync(file).size
    if (bundle == null || (bundle.bytes > 0 && bundle.bytes + bytes > maxBytes))
      bundles.push((bundle = { bytes: 0, files: [] }))
    bundle.bytes += bytes
    bundle.files.push(file)
  }
  return bundles.map((bundle, index) => ({
    ...bundle,
    outfile: `${chunkDir}/scoring-tests-chunk-${index}.cjs`
  }))
}
if (chunkBytes > 0) {
  mkdirSync(chunkDir, { recursive: true })
  for (const stale of globSync(`${chunkDir}/scoring-tests-chunk*`))
    rmSync(stale)
}
const entries =
  chunkBytes > 0
    ? chunked(chunkBytes)
    : [
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
const bundle = async entry =>
  await build({
    ...webSettings,
    plugins: [
      ...webSettings.plugins,
      chatCoreResolvePlugin(),
      pagedListStandInPlugin(),
      {
        name: 'native-initials-measurement-unit',
        setup(build) {
          build.onLoad({ filter: /app\/tv\/remote\.ts$/ }, args => ({
            contents: readFileSync(args.path, 'utf8').replace(
              "import * as ReactNative from 'react-native'",
              "import * as ReactNative from '../../test/tvRemoteRuntime'"
            ),
            loader: 'ts'
          }))
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
      'react-native/Libraries/Utilities/DevLoadingView':
        './src/test/tvDevLoadingStub.ts',
      'react-native-webview': './src/test/eventWebViewStub.tsx',
      'react-native-maps': './src/test/eventNativeMapStub.tsx',
      '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts',
      '@react-native-community/geolocation': './src/test/geolocationStub.ts',
      '@react-native/assets-registry/registry':
        'react-native-web/dist/modules/AssetRegistry'
    },
    stdin: {
      // Each file loads inside a suite of its own, untitled so test titles and
      // --grep match as before. A hook a file declares outside its describe
      // blocks then runs for that file's tests, not for every test bundled.
      contents: [
        "import { describe } from 'mocha'",
        ...entry.files.map(
          file => `describe('', () => {\n  require('./${file}')\n})`
        )
      ].join('\n'),
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
    // The crowd's sounds as files beside the bundle, as the web build has them.
    loader: ASSET_LOADER
  })

await Promise.all(entries.map(bundle))
if (chunkBytes > 0)
  writeFileSync(
    `${chunkDir}/scoring-tests-chunks.json`,
    JSON.stringify(
      entries.map(({ outfile, bytes, files }) => ({
        file: outfile,
        bytes,
        files
      })),
      null,
      2
    ) + '\n'
  )
