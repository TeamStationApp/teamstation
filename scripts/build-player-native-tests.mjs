// The player's native specs: each `src/app/player/**/*.native.spec.ts(x)`,
// and any other `*.native.spec.*` (Tess's among them), bundled alone with the
// web build's settings and `react-native-video`, `react-native-image-picker`
// and `@react-native-documents/picker` aliased to the stubs in
// `src/test/stubs/`, then run with mocha.
//
//   npm run test.playerNative
//
// The specs import their `.native` file by its explicit path. The web bundle
// otherwise never resolves a `.native` file, and `npm test`'s one bundle
// (`build-scoring-tests.mjs`, `*.test.tsx`) would resolve `react-native-video`
// to its real web component, so these specs are kept out of it by their name.
// The player-layouts coverage gate imports `buildNativeSpecs` and runs the
// same bundles under `NODE_V8_COVERAGE`.
import { spawnSync } from 'node:child_process'
import { globSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

/** Every native spec, in a stable order. */
export function nativeSpecs() {
  return globSync([
    'src/**/*.native.spec.ts',
    'src/**/*.native.spec.tsx'
  ]).sort()
}

/** Bundles each spec on its own into `outDir`; answers the bundle paths. */
export async function buildNativeSpecs(outDir) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const bundles = []
  for (const [index, spec] of nativeSpecs().entries()) {
    const outfile = resolve(outDir, `${index}.cjs`)
    await build({
      ...webSettings,
      plugins: [...webSettings.plugins, pagedListStandInPlugin()],
      alias: {
        ...webSettings.alias,
        'react-native-webview': './src/test/eventWebViewStub.tsx',
        'react-native-maps': './src/test/eventNativeMapStub.tsx',
        '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts',
        '@react-native/assets-registry/registry':
          'react-native-web/dist/modules/AssetRegistry',
        'react-native-video': resolve('src/test/stubs/reactNativeVideo.tsx'),
        'react-native-image-picker': resolve(
          'src/test/stubs/reactNativeImagePicker.ts'
        ),
        '@react-native-documents/picker': resolve(
          'src/test/stubs/reactNativeDocumentsPicker.ts'
        )
      },
      stdin: {
        contents: `import './${spec}'`,
        resolveDir: process.cwd(),
        sourcefile: `player-native-spec-${index}.ts`
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
        'chai'
      ],
      define: {
        __DEV__: 'true',
        TS_API_BASE_URL: JSON.stringify('/api/v1'),
        'process.env.TS_SENTRY_DSN': JSON.stringify(''),
        'process.env.NODE_ENV': JSON.stringify('test')
      },
      loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
    })
    bundles.push({ spec, outfile })
  }
  return bundles
}

/** Runs each bundle with mocha; answers whether every one passed. */
export function runNativeSpecs(bundles, env = {}) {
  let passed = true
  for (const { spec, outfile } of bundles) {
    console.log(`\n${spec}`)
    const result = spawnSync(
      'node_modules/.bin/mocha',
      [
        '-r',
        'sucrase/register',
        '-r',
        './src/test/scoringDomSetup.cjs',
        '--timeout',
        '60000',
        '--exit',
        outfile
      ],
      { stdio: 'inherit', env: { ...process.env, ...env } }
    )
    if (result.status !== 0) passed = false
  }
  return passed
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundles = await buildNativeSpecs(resolve('lib/player-native-specs'))
  if (bundles.length === 0) console.log('No native specs.')
  process.exit(runNativeSpecs(bundles) ? 0 : 1)
}
