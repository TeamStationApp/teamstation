// Test infrastructure: merge unit, integration and child-process counters from
// exactly one committed revision before applying the changed-line gate.
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { webSettings } from './web-build-settings.mjs'

const require = createRequire(import.meta.url)
const {
  coverageSource,
  verifyCoverageSource
} = require('./coverage-provenance.cjs')
const base = process.env.TS_COVERAGE_BASE ?? 'origin/master'
const cwd = process.cwd()
const source = coverageSource(cwd, base)
const report = resolve('coverage/liveOrigin')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })
writeFileSync(resolve(report, 'source.json'), JSON.stringify(source, null, 2))
const run = (program, args, env = process.env) => {
  const result = spawnSync(program, args, { stdio: 'inherit', env })
  if (result.status !== 0) throw new Error(`${program} exited ${result.status}`)
}
const env = { ...process.env, NODE_V8_COVERAGE: temp }
run(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '--timeout',
    '120000',
    '--exit',
    '--reporter',
    'dot',
    '--spec',
    'src/common/observability/errors.test.ts',
    '--spec',
    'src/common/playback.test.ts',
    '--spec',
    'src/server/dev/fakeSpace.test.ts',
    '--spec',
    'src/server/media/**/*.test.ts',
    '--spec',
    'src/server/live/**/*.test.ts',
    '--spec',
    'src/server/ingest/**/*.test.ts',
    '--spec',
    'src/server/routes/stills.test.ts',
    '--spec',
    'src/server/routes/hlsPlayback.test.ts',
    '--spec',
    'src/server/groups/live*.test.ts'
  ],
  env
)
// Bundle each component suite alone so unrelated test module state cannot
// affect its assertions. Their source maps join the same revision's counters.
const appSuites = [
  'src/app/screens/gameLivePlayback.test.tsx',
  'src/app/screens/GameScreen.player.test.tsx',
  'src/app/player/multiCam/useMultiCam.test.tsx'
]
for (const [index, suite] of appSuites.entries()) {
  const bundle = resolve(`lib/live-origin-tests/${index}.cjs`)
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
      contents: `import './${suite}'`,
      resolveDir: cwd,
      sourcefile: `origin-test-${index}.ts`
    },
    outfile: bundle,
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
    }
  })
  run(
    'node_modules/.bin/mocha',
    [
      '-r',
      './src/test/scoringDomSetup.cjs',
      '--timeout',
      '120000',
      '--exit',
      '--reporter',
      'dot',
      bundle
    ],
    env
  )
}
run(
  process.execPath,
  [
    '-r',
    'sucrase/register',
    'src/app/player/liveOrigin.e2e.ts',
    '--contract-only',
    ...(process.env.TS_ORIGIN_COVERAGE_BEFORE === '1' ? ['--before'] : [])
  ],
  env
)
verifyCoverageSource(source, cwd, base)
// Normalize source-map identifiers, never measured counters.
for (const file of readdirSync(temp)) {
  const path = resolve(temp, file)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {})) {
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(name =>
        name.startsWith('file://') ? fileURLToPath(name) : name
      )
  }
  writeFileSync(path, JSON.stringify(data))
}
run('node_modules/.bin/c8', [
  'report',
  '--all',
  '--exclude-after-remap',
  '--reporter=json',
  '--reporter=text',
  '--reports-dir',
  report,
  '--temp-directory',
  temp,
  '--include',
  'src/server/**/*.ts',
  '--include',
  'src/common/observability/serverCodeFiles.ts',
  '--include',
  'src/common/api.ts',
  '--include',
  'src/app/screens/GameScreen.tsx',
  '--include',
  'src/app/player/multiCam/useMultiCam.ts',
  '--exclude',
  '**/*.test.*',
  '--exclude',
  '**/*.e2e.ts',
  '--exclude',
  '**/*Fixture*.ts',
  '--exclude',
  '**/*.integration.ts'
])
run(process.execPath, [
  'scripts/changed-line-check.cjs',
  '--base',
  base,
  '--coverage',
  resolve(report, 'coverage-final.json'),
  '--report',
  resolve(report, 'changed-lines.json'),
  '--min',
  '95',
  '--ext',
  '.ts',
  '--ext',
  '.tsx',
  '--exclude',
  '**/*Fixture*.ts',
  'src/server',
  'src/common',
  'src/app'
])
verifyCoverageSource(source, cwd, base)
