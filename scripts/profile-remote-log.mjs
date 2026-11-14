import { spawnSync } from 'node:child_process'

/**
 * Per-notification time and heap of the remote scoring panel over a long
 * game: builds the scoring test bundle, then runs only the env-gated
 * `remote log profile` spec with a collectable heap.
 *
 *   node scripts/profile-remote-log.mjs [--at-bats 100]
 */
const at = process.argv.indexOf('--at-bats')
const atBats = at < 0 ? '100' : process.argv[at + 1]
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run('node', ['scripts/build-scoring-tests.mjs'])
run(
  'node',
  [
    '--expose-gc',
    'node_modules/mocha/bin/mocha.js',
    '-r',
    'sucrase/register',
    '-r',
    './src/test/scoringDomSetup.cjs',
    'lib/scoring-tests.cjs',
    '--grep',
    'remote log profile'
  ],
  {
    ...process.env,
    TS_REMOTE_LOG_PROFILE: '1',
    TS_REMOTE_LOG_AT_BATS: atBats
  }
)
