// The outbox's offline suites, the web cache and its executor, run on the
// web's SQLite WASM (`TS_TEST_SQLITE=wasm`): each suite bundled alone, as
// the web build resolves it, in a mocha process of its own. Any failing
// suite fails the run. Cases that need the phone's file between launches
// skip themselves on WASM. A suite's `skip` names cases that fail bundled
// alone on node:sqlite as well, as on the branch's base: they lean on their
// bundle neighbours under `npm test`, which still runs them.
//
//   npm run test.wasmCache
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { bundleAppSuite } from './appSuiteBundle.mjs'

const suites = [
  { path: 'src/app/sync/wasmSqliteExecutor.test.ts' },
  { path: 'src/app/sync/cache.test.ts' },
  { path: 'src/app/sync/offlineScoring.test.tsx' },
  {
    path: 'src/app/scoring/offlineGameUnderWay.test.tsx',
    skip: 'lists the game in Past, to tap'
  },
  { path: 'src/app/scoring/scoringOpenOffline.test.tsx' },
  { path: 'src/app/App.offlineBanner.test.tsx' }
]

const bundles = resolve('lib/wasmCache-tests')
rmSync(bundles, { recursive: true, force: true })
mkdirSync(bundles, { recursive: true })
const failed = []
for (const [index, { path, skip }] of suites.entries()) {
  const outfile = resolve(bundles, `${index}.cjs`)
  await bundleAppSuite({
    path,
    outfile,
    sourcefile: `wasm-cache-test-${index}.ts`
  })
  console.log(`\n${path}`)
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
      ...(skip == null ? [] : ['--grep', skip, '--invert']),
      outfile
    ],
    { stdio: 'inherit', env: { ...process.env, TS_TEST_SQLITE: 'wasm' } }
  )
  if (result.status !== 0) failed.push(path)
}
if (failed.length > 0) {
  console.error(`\nFailed on SQLite WASM:\n${failed.join('\n')}`)
  process.exit(1)
}
console.log(`\nAll ${suites.length} suites passed on SQLite WASM`)
