// The two tiers of the mocha suites. Unit tests run on every commit and open
// no database, store, outside socket or child process; integration tests need
// one of those and run with `npm run test.integration`, against the servers
// TS_TEST_DATABASE_URL and TS_TEST_REDIS_URL name. A file is integration by
// its name: `*.integration.test.ts` or `*.integration.test.tsx`.
import { globSync } from 'node:fs'

/** Where the guard that keeps the unit tier honest is loaded from. */
export const UNIT_GUARD = './scripts/unitTierGuard.cjs'

/** Addresses that refuse, so a unit test that reaches for a server says why. */
export const UNIT_SERVERS = {
  TS_TEST_DATABASE_URL: 'postgres://unit-tests-have-no-database.invalid/x',
  TS_TEST_REDIS_URL: 'redis://unit-tests-have-no-redis.invalid:6379'
}

/**
 * Integration files that run last, alone: the FFmpeg writers and the change
 * feed timed against the wall clock, and the files that build the whole server or the app's test
 * bundles, which starve or stop beside other groups.
 */
export const SERIAL = [
  'src/server/live/codecHold.integration.test.ts',
  'src/server/live/mismatchedPublish.integration.test.ts',
  'src/server/live/feedSync.integration.test.ts',
  'src/server/oauth/oauth.integration.test.ts',
  'src/test/testRunner.integration.test.ts'
]

/**
 * The tests of these scripts. The rest of `scripts/**` keeps its own runners
 * (`test:portable`).
 */
export const SCRIPT_TESTS = [
  'scripts/testModels.test.ts',
  'scripts/testTiers.test.ts',
  'scripts/testTools.test.ts'
]

/** Whether `path` is an integration test file. */
export function isIntegration(path) {
  return /\.integration\.test\.tsx?$/.test(path)
}

/** Which tier `--tier` asks for; unit when it is not given. */
export function tierOf(argv) {
  const at = argv.indexOf('--tier')
  const named = argv.find(arg => arg.startsWith('--tier='))
  const tier =
    at >= 0
      ? argv[at + 1]
      : named != null
        ? named.slice('--tier='.length)
        : 'unit'
  if (tier !== 'unit' && tier !== 'integration')
    throw new Error(`Expected --tier unit or integration, got ${String(tier)}`)
  return tier
}

/** The arguments with `--tier` taken out, for mocha. */
export function withoutTier(argv) {
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tier') i++
    else if (!argv[i].startsWith('--tier=')) rest.push(argv[i])
  }
  return rest
}

const notModules = path => path.split(/[\\/]/).includes('node_modules')

/**
 * @typedef {(pattern: string, options: { exclude: (path: string) => boolean }) => string[]} Glob
 */

/**
 * The `.test.ts` files of `tier`, sorted, without SERIAL.
 * @param {'unit' | 'integration'} tier
 * @param {Glob} [glob]
 */
export function specFiles(tier, glob = globSync) {
  const files = [
    ...glob('src/**/*.test.ts', { exclude: notModules }),
    ...glob('e2e/**/*.test.ts', { exclude: notModules }),
    ...SCRIPT_TESTS
  ]
  return [...new Set(files)]
    .filter(file => isIntegration(file) === (tier === 'integration'))
    .filter(file => !SERIAL.includes(file))
    .sort()
}

/**
 * The app's `.test.tsx` files of `tier`, bundled by build-scoring-tests.mjs.
 * @param {'unit' | 'integration'} tier
 * @param {Glob} [glob]
 */
export function appFiles(tier, glob = globSync) {
  return glob('src/**/*.test.tsx', { exclude: notModules })
    .filter(file => isIntegration(file) === (tier === 'integration'))
    .sort()
}

/**
 * How a group of `tier` runs: the extra mocha `-r` modules, the variables each
 * process gets, and whether SERIAL runs at the end.
 */
export function tierOptions(argv, env = process.env) {
  const tier = tierOf(argv)
  if (tier === 'unit') {
    return {
      tier,
      require: [UNIT_GUARD],
      env: { ...env, ...UNIT_SERVERS },
      serial: []
    }
  }
  return { tier, require: [], env: { ...env }, serial: SERIAL }
}
