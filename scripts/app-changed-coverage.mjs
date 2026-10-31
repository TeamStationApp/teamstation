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

const { nativeExcludes } = createRequire(import.meta.url)(
  './app-native-excludes.cjs'
)

// Line coverage of the app files this branch changes. The gate reads
// `git diff origin/master...HEAD`, so it runs after the milestone is committed.
const temp = resolve('coverage/uiFixes/tmp')
rmSync(resolve('coverage/uiFixes'), { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

for (const step of [
  ['scripts/chatCryptoBuild.mjs', 'node', 'wasm'],
  ['scripts/build-scoring-tests.mjs']
]) {
  const build = spawnSync('node', step, { stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const test = spawnSync(
  'node_modules/.bin/mocha',
  [
    // Counting every line slows the suite, and mocha would idle for ever on
    // the handles a server test leaves open.
    '--timeout',
    '60000',
    '--exit',
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    '--extension',
    'ts',
    '--spec',
    'src/**/*.test.ts',
    '--spec',
    'lib/scoring-tests.cjs',
    '--ignore',
    '**/node_modules/**'
  ],
  { stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: temp } }
)

// Node caches multi-source bundle maps as file URLs. c8 compares filesystem
// paths before resolving each source, otherwise marking every bundled
// function covered. Normalize map identifiers, never counters.
for (const file of readdirSync(temp)) {
  const path = resolve(temp, file)
  const data = JSON.parse(readFileSync(path, 'utf8'))
  for (const map of Object.values(data['source-map-cache'] ?? {})) {
    if (map.data?.sources != null)
      map.data.sources = map.data.sources.map(source =>
        source.startsWith('file://') ? fileURLToPath(source) : source
      )
  }
  writeFileSync(path, JSON.stringify(data))
}

const report = spawnSync(
  'node_modules/.bin/c8',
  [
    'report',
    '--reporter=json',
    '--reports-dir',
    'coverage/uiFixes',
    '--exclude',
    '**/*.test.*',
    '--exclude',
    '**/*.integration.ts',
    '--exclude',
    '**/*.e2e.ts',
    '--exclude',
    'src/test/**',
    '--exclude-after-remap'
  ],
  { stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: temp } }
)

const check = spawnSync(
  'node',
  [
    'scripts/changed-line-check.cjs',
    '--coverage',
    'coverage/uiFixes/coverage-final.json',
    '--ext',
    '.ts',
    '--ext',
    '.tsx',
    // A native twin runs on a phone, never under jsdom, and its specs run
    // in the native bundles (`npm run test.playerNative`), not this one.
    ...nativeExcludes().flatMap(glob => ['--exclude', glob]),
    '--exclude',
    '**/*.native.ts',
    '--exclude',
    '**/*.native.spec.tsx',
    '--exclude',
    '**/*.native.spec.ts',
    // The test bundle resolves a barrel import to the implementation, so
    // src/app/components/index.ts has no coverage record of its own.
    '--exclude',
    'src/app/components/index.ts',
    // Type-only: the walk-up and cue TurboModules' codegen specs, which only the
    // native bundle loads (every other importer uses `import type`), the
    // glass's props interface, the field's prop types and the narration
    // players' shared interface. None has a line to run.
    '--exclude',
    'src/app/field/fieldTypes.ts',
    '--exclude',
    'src/app/replay/narrationPlayerTypes.ts',
    '--exclude',
    'src/app/walkup/NativeWalkUpMusic.ts',
    '--exclude',
    'src/app/scoring/NativeCueSounds.ts',
    '--exclude',
    'src/app/components/glassViewProps.ts',
    // The footers' shared props: types only.
    '--exclude',
    'src/app/stream/streamFooterProps.ts',
    // Tess's client shapes, which every importer takes as `import type`.
    '--exclude',
    'src/app/tess/tessTypes.ts',
    // TurboModule specs: codegen reads them, and loading one needs React
    // Native's native side, which no test here has.
    '--exclude',
    'src/app/**/Native*.ts',
    // Types only: nothing of them is left to run.
    '--exclude',
    'src/app/chat/chatVideoProps.ts',
    '--exclude',
    'src/app/chat/screenEngine.ts',
    'src/app'
  ],
  { stdio: 'inherit' }
)

if (test.status !== 0) process.exit(test.status ?? 1)
if (report.status !== 0) process.exit(report.status ?? 1)
process.exit(check.status ?? 1)
