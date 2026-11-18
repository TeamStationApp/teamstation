// The native modes of scripts/splash-coverage.mjs. Each gate prints its
// commands on `$` lines and holds the changed lines it names to 95%.
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const PACKAGE = 'mobile/apps/common/TeamStationSplash'

/**
 * The Swift gates: the whole package through its tests on the iOS simulator
 * SPLASH_IOS_SIMULATOR (and on the tvOS one SPLASH_TV_SIMULATOR when set),
 * which run the core's tests and the UIKit target's together; and the phone
 * app's AppDelegate through its hosted TeamStationTests. The package's own
 * result bundle lists its files, so xccov reads them directly. It is not
 * measured with `swift test` on the Mac, where its UIKit target compiles to
 * nothing and llvm-cov refuses the export.
 */
export function swiftGate({ run, base }) {
  const ios = process.env.SPLASH_IOS_SIMULATOR
  if (ios == null)
    throw new Error('Supply SPLASH_IOS_SIMULATOR, an iOS simulator UDID')
  const swiftGateArgs = ['--base', base, '--min', '95']
  const destinations = [`platform=iOS Simulator,id=${ios}`]
  const tv = process.env.SPLASH_TV_SIMULATOR
  if (tv != null) destinations.push(`platform=tvOS Simulator,id=${tv}`)
  for (const [index, destination] of destinations.entries()) {
    const derived = resolve(`coverage/splash/swift-${index}`)
    rmSync(derived, { recursive: true, force: true })
    run(
      'xcodebuild',
      [
        'test',
        '-scheme',
        'TeamStationSplash',
        '-destination',
        destination,
        '-enableCodeCoverage',
        'YES',
        '-derivedDataPath',
        derived,
        '-resultBundlePath',
        `${derived}/result.xcresult`,
        '-quiet'
      ],
      { cwd: resolve(PACKAGE) }
    )
    run('node', [
      'scripts/swift-changed-line-coverage.cjs',
      '--xcresult',
      `${derived}/result.xcresult`,
      ...swiftGateArgs,
      // Generated constants: no executable line to measure.
      '--exclude',
      `${PACKAGE}/Sources/TeamStationSplashCore/SplashTimeline.swift`,
      `${PACKAGE}/Sources`
    ])
  }

  const app = resolve('coverage/splash/app')
  rmSync(app, { recursive: true, force: true })
  run('xcodebuild', [
    'test',
    '-workspace',
    'ios/TeamStation.xcworkspace',
    '-scheme',
    'TeamStation',
    '-configuration',
    'Release',
    '-destination',
    `platform=iOS Simulator,id=${ios}`,
    '-enableCodeCoverage',
    'YES',
    '-derivedDataPath',
    'ios/DerivedData',
    '-resultBundlePath',
    `${app}/result.xcresult`,
    '-only-testing:TeamStationTests',
    '-quiet'
  ])
  run('node', [
    'scripts/swift-changed-line-coverage.cjs',
    '--xcresult',
    `${app}/result.xcresult`,
    ...swiftGateArgs,
    'ios/TeamStation/AppDelegate.swift'
  ])
}

/**
 * The Kotlin gate: app.teamstation.app.splash and MainActivity, from
 * :app:splashCoverage, which merges the JVM tests with TS_SPLASH_EXEC, the
 * instrumented run's execution data, when it is set.
 */
export function kotlinGate({ run, base }) {
  run('./android/gradlew', [
    '-p',
    'android',
    ':app:splashCoverage',
    '--rerun-tasks'
  ])
  run('node', [
    'scripts/changed-line-check.cjs',
    '--base',
    base,
    '--min',
    '95',
    '--jacoco',
    'android/app/build/reports/jacoco/splashCoverage/splashCoverage.xml',
    '--source-root',
    'android/app/src/main/java',
    '--ext',
    '.kt',
    // Generated constants: no executable line to measure.
    '--exclude',
    'android/app/src/main/java/app/teamstation/app/splash/SplashTimeline.kt',
    'android/app/src/main/java/app/teamstation/app/splash',
    'android/app/src/main/java/app/teamstation/app/MainActivity.kt'
  ])
}
