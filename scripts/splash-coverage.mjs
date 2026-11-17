// The launch splash's changed-line coverage gates: 90% for --js, which only
// unit tests reach, and 95% for --swift and --kotlin, whose counters combine
// the unit tests with the hosted and instrumented ones on a device (AGENTS.md):
//
//   TS_COVERAGE_BASE=origin/develop node scripts/splash-coverage.mjs --js|--swift|--kotlin|--all
//
// --js     scripts/splash/** through c8 over the unit test and the macOS-only
//          generator test (scripts/splash/splashAssets.mac-test.ts).
// --swift  mobile/apps/common/TeamStationSplash/** and the phone app's
//          AppDelegate (scripts/splash-coverage-native.mjs), on the iOS
//          simulator SPLASH_IOS_SIMULATOR.
// --kotlin android/app/src/main/java/app/teamstation/app/splash/** and
//          MainActivity, from :app:splashCoverage (with TS_SPLASH_EXEC, the
//          instrumented run's execution data, merged when it is set).
// Every command is printed on a `$` line before it runs.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error(
    'Supply TS_COVERAGE_BASE, the base the branch is measured from'
  )
const modes = process.argv.slice(2)
const known = ['--js', '--swift', '--kotlin', '--all']
if (modes.length === 0 || modes.some(mode => !known.includes(mode)))
  throw new Error(`Specify one of ${known.join(', ')}`)
const all = modes.includes('--all')

const run = (file, args, options = {}) => {
  console.log('$ ' + [file, ...args].join(' '))
  execFileSync(file, args, { stdio: 'inherit', ...options })
}
const gate = args =>
  run('node', [
    'scripts/changed-line-check.cjs',
    '--base',
    base,
    '--min',
    '90',
    ...args
  ])

if (all || modes.includes('--js')) {
  const dir = resolve('coverage/splash/js')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  run('npx', [
    'c8',
    '--reporter=json',
    '--reporter=text-summary',
    '--report-dir',
    dir,
    '--include',
    'scripts/splash/*.mjs',
    'mocha',
    '-r',
    'sucrase/register',
    '--extension',
    'ts',
    'src/test/splashAssets.test.ts',
    'scripts/splash/splashAssets.mac-test.ts'
  ])
  gate([
    '--coverage',
    'coverage/splash/js/coverage-final.json',
    '--ext',
    '.mjs',
    'scripts/splash'
  ])
}

if (all || modes.includes('--swift')) {
  const { swiftGate } = await import('./splash-coverage-native.mjs')
  swiftGate({ run, base })
}

if (all || modes.includes('--kotlin')) {
  const { kotlinGate } = await import('./splash-coverage-native.mjs')
  kotlinGate({ run, base })
}
