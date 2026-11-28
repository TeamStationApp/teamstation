// Test infrastructure: the multi-angle grid's alignment suites, measured on
// exactly one committed revision, then the changed-line gate for
// src/app/player/multiCam.
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

import { pagedListStandInPlugin } from './pagedListStandInPlugin.mjs'
import { webSettings } from './web-build-settings.mjs'

const require = createRequire(import.meta.url)
const {
  coverageSource,
  verifyCoverageSource
} = require('./coverage-provenance.cjs')
const base = process.env.TS_COVERAGE_BASE ?? 'origin/develop'
const cwd = process.cwd()
const source = coverageSource(cwd, base)
const report = resolve('coverage/gridAlign')
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
    'src/app/player/multiCam/align.test.ts',
    '--spec',
    'src/app/player/multiCam/scrubSeeks.test.ts'
  ],
  env
)
// The grid's hook suite runs as a bundle, as the app does; its source map
// joins the same revision's counters. Nothing is shaken out of it: code
// the bundle drops has no counters of its own, and c8 counts a source line
// with no generated code as covered, which would cover every line of a
// function this suite never reaches whatever the other suites say.
const bundle = resolve('lib/grid-align-tests/useMultiCam.cjs')
await build({
  ...webSettings,
  plugins: [...webSettings.plugins, pagedListStandInPlugin()],
  alias: {
    ...webSettings.alias,
    'react-native-webview': './src/test/eventWebViewStub.tsx',
    'react-native-maps': './src/test/eventNativeMapStub.tsx',
    '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts',
    '@react-native/assets-registry/registry':
      'react-native-web/dist/modules/AssetRegistry'
  },
  stdin: {
    contents: `import './src/app/player/multiCam/useMultiCam.test.tsx'`,
    resolveDir: cwd,
    sourcefile: 'grid-align-test.ts'
  },
  outfile: bundle,
  bundle: true,
  treeShaking: false,
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
verifyCoverageSource(source, cwd, base)
// Node's permission model (`--permission`, which `socket npm` puts in
// NODE_OPTIONS) stops V8 writing its coverage, so nothing would be measured.
if (readdirSync(temp).length === 0) {
  const permission = /--permission\b/.test(process.env.NODE_OPTIONS ?? '')
  console.error(
    `\nNo V8 coverage was written to ${temp}.` +
      (permission
        ? ' NODE_OPTIONS has --permission (as under `socket npm`), which stops V8 writing coverage; run `npm run coverage.gridAlign` without socket.'
        : '')
  )
  process.exit(1)
}
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
  'src/app/player/multiCam/*.ts',
  '--exclude',
  '**/*.test.*'
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
  '90',
  '--ext',
  '.ts',
  '--exclude',
  '**/*.test.*',
  'src/app/player/multiCam'
])
verifyCoverageSource(source, cwd, base)
