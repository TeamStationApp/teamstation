import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

// Line coverage of the server, common and migration files this branch
// changes, from the tests in those trees: the app's own `.ts` tests need the
// DOM setup and are `app-changed-coverage.mjs`'s to run. The gate reads
// `git diff origin/master...HEAD`, so it runs after the commit. Each step
// runs whatever the one before it returned: a failing test never hides the
// changed-line figure, and the failing tests are named so each can be held
// against the base.
const report = resolve('coverage/changedServer')
const temp = resolve(report, 'tmp')
rmSync(report, { recursive: true, force: true })
mkdirSync(temp, { recursive: true })

const test = spawnSync(
  'node_modules/.bin/mocha',
  [
    '-r',
    'sucrase/register',
    '--extension',
    'ts',
    '--reporter',
    'dot',
    // A test that leaves a handle open must not keep the gate from ending.
    '--exit',
    '--spec',
    'src/server/**/*.test.ts',
    '--spec',
    'src/common/**/*.test.ts',
    '--spec',
    'src/migrate/**/*.test.ts',
    '--ignore',
    '**/node_modules/**'
  ],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NODE_V8_COVERAGE: temp }
  }
)
process.stdout.write(test.stdout ?? '')
const failing = [...(test.stdout ?? '').matchAll(/^ {2}\d+\) (.+)$/gm)].map(
  match => match[1]
)

const coverage = spawnSync(
  'node_modules/.bin/c8',
  [
    'report',
    '--reporter=json',
    '--reports-dir',
    report,
    '--temp-directory',
    temp,
    '--include',
    'src/**/*.ts',
    '--exclude',
    '**/*.test.ts',
    '--exclude',
    '**/*.e2e.ts',
    '--exclude',
    '**/*.integration.ts'
  ],
  { stdio: 'inherit' }
)

const check = spawnSync(
  'node',
  [
    'scripts/changed-line-check.cjs',
    '--coverage',
    resolve(report, 'coverage-final.json'),
    '--ext',
    '.ts',
    '--exclude',
    'src/server/index.ts',
    '--exclude',
    'src/server/statsBuilder/start.ts',
    'src/server',
    'src/common',
    'src/migrate'
  ],
  { stdio: 'inherit' }
)

if (failing.length > 0) {
  console.log('\nFailing tests (hold each against origin/master):')
  for (const name of failing) console.log(`  - ${name}`)
}
if (coverage.status !== 0) process.exit(coverage.status ?? 1)
if (check.status !== 0) process.exit(check.status ?? 1)
process.exit(test.status ?? 1)
