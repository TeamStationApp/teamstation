// The phones' half of the sponsor coverage gate, `npm run coverage.sponsors
// -- --native`: the SponsorMedia native module, on a simulator and an
// emulator the caller leased, each held to 90% of its changed lines.
//
//   SPONSOR_IOS_SIMULATOR=<iOS simulator UDID> \
//   SPONSOR_ANDROID_EMULATOR=<emulator serial> \
//   TS_COVERAGE_BASE=$(git merge-base origin/develop HEAD) \
//     node scripts/sponsor-coverage-native.mjs [swift] [kotlin]
//
// - Swift: `TeamStationTests/SponsorMediaTests` through `xcodebuild test`
//   with coverage on the simulator, then `swift-changed-line-coverage.cjs`
//   over `ios/TeamStation/SponsorMedia`. SPONSOR_IOS_DERIVED_DATA names the
//   build's derived data (`ios/DerivedData` by default), so a second run
//   builds only what changed.
// - Kotlin: `SponsorMediaCoreTest` on the JVM, and `SponsorMediaModuleTest`
//   on the emulator through `connectedDebugAndroidTest` with
//   TS_SPONSOR_COVERAGE=1, which really encodes; their execution data merged
//   by `:app:sponsorMediaCoverage`, then `changed-line-check.cjs` over
//   `app.teamstation.app.sponsormedia`. Gradle needs JAVA_HOME at a JDK from
//   17 to 21 and TS_ANDROID_DEBUG_KEYSTORE (src/MOBILE.md).
//
// Naming `swift` or `kotlin` runs only that gate. Every command is printed on
// a `$` line. The run writes only into a fresh directory named for its UTC
// start, `coverage/sponsors-native/<stamp>/`, and refuses, naming it, when it
// is already there; it never deletes or overwrites a file.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  statSync
} from 'node:fs'
import { resolve } from 'node:path'

const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error('Set TS_COVERAGE_BASE to the branch base (git merge-base)')
const asked = process.argv.slice(2)
for (const name of asked)
  if (name !== 'swift' && name !== 'kotlin')
    throw new Error(`Expected swift or kotlin, got ${name}`)
const wants = name => asked.length === 0 || asked.includes(name)

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z')
const out = resolve('coverage/sponsors-native', stamp)
if (existsSync(out))
  throw new Error(`${out} already exists; this run will not reuse it`)
mkdirSync(out, { recursive: true })
console.log(`Writing to ${out}`)

const failures = []
function run(command, args, { env = {}, cwd } = {}) {
  console.log(
    '$',
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    command,
    ...args
  )
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd,
    env: { ...process.env, ...env }
  })
  if (result.status !== 0) failures.push(`${command} ${args.join(' ')}`)
  return result.status === 0
}
function required(name, what) {
  const value = process.env[name]
  if (value == null || value === '') throw new Error(`Supply ${name}, ${what}`)
  return value
}
/** Copies `from` to a new file in the run's directory, never over one. */
function keep(from, name) {
  const to = resolve(out, name)
  if (existsSync(to)) throw new Error(`${to} already exists`)
  copyFileSync(from, to)
}

if (wants('swift')) {
  const simulator = required('SPONSOR_IOS_SIMULATOR', 'an iOS simulator UDID')
  const derived = resolve(
    process.env.SPONSOR_IOS_DERIVED_DATA ?? 'ios/DerivedData'
  )
  const result = resolve(out, 'swift.xcresult')
  if (
    run('xcodebuild', [
      'test',
      '-workspace',
      'ios/TeamStation.xcworkspace',
      '-scheme',
      'TeamStation',
      '-configuration',
      'Debug',
      '-destination',
      `platform=iOS Simulator,id=${simulator}`,
      '-enableCodeCoverage',
      'YES',
      '-derivedDataPath',
      derived,
      '-resultBundlePath',
      result,
      '-only-testing:TeamStationTests/SponsorMediaTests',
      'SWIFT_ENABLE_EXPLICIT_MODULES=NO',
      '-quiet'
    ])
  )
    run('node', [
      'scripts/swift-changed-line-coverage.cjs',
      '--xcresult',
      result,
      '--base',
      base,
      '--min',
      '90',
      'ios/TeamStation/SponsorMedia'
    ])
}

if (wants('kotlin')) {
  const emulator = required('SPONSOR_ANDROID_EMULATOR', 'an emulator serial')
  const gradle = (args, env) =>
    run('./android/gradlew', ['-p', 'android', ...args], { env })
  const started = Date.now()
  gradle([':app:testDebugUnitTest', '--tests', '*SponsorMediaCore*', '--rerun'])
  gradle(
    [
      ':app:connectedDebugAndroidTest',
      '-Pandroid.testInstrumentationRunnerArguments.class=app.teamstation.app.sponsormedia.SponsorMediaModuleTest'
    ],
    { TS_SPONSOR_COVERAGE: '1', ANDROID_SERIAL: emulator }
  )
  // This run's execution files from the emulator, not an earlier run's.
  const execs = globSync(
    'android/app/build/outputs/code_coverage/debugAndroidTest/connected/**/*.ec'
  )
    .map(path => resolve(path))
    .filter(path => statSync(path).mtimeMs >= started)
  if (execs.length === 0) failures.push('no coverage came off the emulator')
  for (const [index, exec] of execs.entries()) keep(exec, `device-${index}.ec`)
  gradle([':app:sponsorMediaCoverage', '--rerun'], {
    TS_SPONSOR_EXEC: execs.join(',')
  })
  const report = resolve(
    'android/app/build/reports/jacoco/sponsorMediaCoverage/sponsorMediaCoverage.xml'
  )
  if (existsSync(report)) keep(report, 'kotlin.xml')
  run('node', [
    'scripts/changed-line-check.cjs',
    '--base',
    base,
    '--min',
    '90',
    '--jacoco',
    report,
    '--source-root',
    'android/app/src/main/java',
    '--ext',
    '.kt',
    'android/app/src/main/java/app/teamstation/app/sponsormedia'
  ])
}

if (failures.length > 0) {
  console.error(`\nSponsor native coverage failed: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`\nSponsor native coverage passed; records in ${out}`)
