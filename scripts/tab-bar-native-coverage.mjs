import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import coverage from './changed-line-coverage.cjs'

export function tabBarNativeCounts(
  paths,
  archiveFiles,
  read,
  root = process.cwd()
) {
  const available = new Set(
    archiveFiles
      .trim()
      .split('\n')
      .map(path => normalize(path))
  )
  const counts = {}
  for (const path of paths) {
    const absolute = resolve(root, path)
    if (!available.has(absolute))
      throw new Error('No native coverage record for ' + path)
    const lines = coverage.xccovCounts(read(absolute))[absolute]
    if (!lines || Object.keys(lines).length === 0)
      throw new Error('No executable coverage counters for ' + path)
    counts[path] = lines
  }
  return counts
}

export function measureNative(
  base,
  report,
  tests = ['TeamStationTests/TabBarViewTests']
) {
  const simulator = process.env.TS_TAB_IOS
  if (!simulator) throw new Error('Set TS_TAB_IOS to the task simulator UDID')
  const result = join(mkdtempSync(join(report, 'xctest-')), 'result.xcresult')
  execFileSync(
    'xcodebuild',
    [
      'test',
      '-workspace',
      'ios/TeamStation.xcworkspace',
      '-scheme',
      'TeamStation',
      '-configuration',
      'Release',
      '-destination',
      'id=' + simulator,
      '-derivedDataPath',
      process.env.TS_TAB_DERIVED_DATA ?? join(report, 'DerivedData'),
      '-parallel-testing-enabled',
      'NO',
      '-enableCodeCoverage',
      'YES',
      ...tests.map(test => '-only-testing:' + test),
      '-resultBundlePath',
      result,
      '-jobs',
      '4',
      'CODE_SIGNING_ALLOWED=NO',
      'SWIFT_ENABLE_EXPLICIT_MODULES=NO',
      '-quiet'
    ],
    { stdio: 'inherit' }
  )
  const xccov = (...args) =>
    execFileSync('xcrun', ['xccov', 'view', '--archive', ...args, result], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
  return tabBarNativeCounts(nativeFiles(base), xccov('--file-list'), path =>
    JSON.parse(xccov('--json', '--file', path))
  )
}

/** LLVM writes one profile per app process. Limit the export to the changed sources. */
export function profileCounts(binary, profiles, files, directory) {
  if (!profiles.length) throw new Error('No measured application profiles')
  const profdata = join(directory, 'merged.profdata')
  execFileSync('xcrun', [
    'llvm-profdata',
    'merge',
    '-sparse',
    ...profiles,
    '-o',
    profdata
  ])
  const lcov = execFileSync(
    'xcrun',
    [
      'llvm-cov',
      'export',
      '-format=lcov',
      '--check-binary-ids',
      '-arch',
      process.arch === 'arm64' ? 'arm64' : 'x86_64',
      '-instr-profile',
      profdata,
      binary,
      '--sources',
      ...files.map(file => resolve(file))
    ],
    { encoding: 'utf8' }
  )
  const measured = coverage.lcovCounts(lcov)
  return Object.fromEntries(
    files.map(file => {
      const rows = measured[resolve(file)]
      if (rows == null || !Object.keys(rows).length)
        throw new Error('Missing LLVM counters for ' + file)
      return [file, rows]
    })
  )
}

/** Run the actual iOS journey on the caller's disposable simulator. */
export async function measureSimulatorJourney(base, directory, command) {
  const simulator = process.env.TS_TAB_IOS
  if (!simulator || !command.length)
    throw new Error('Supply TS_TAB_IOS and a native journey command')
  const derived =
    process.env.TS_TAB_DERIVED_DATA ?? join(directory, 'DerivedData')
  const appId = 'app.teamstation.tabbarcoverage.r' + process.pid + Date.now()
  const product = join(
    derived,
    'Build/Products/Release-iphonesimulator/TeamStation.app'
  )
  execFileSync(
    'xcodebuild',
    [
      'build-for-testing',
      '-workspace',
      'ios/TeamStation.xcworkspace',
      '-scheme',
      'TeamStation',
      '-configuration',
      'Release',
      '-destination',
      'id=' + simulator,
      '-derivedDataPath',
      derived,
      '-enableCodeCoverage',
      'YES',
      'TS_APP_BUNDLE_ID=' + appId,
      'OTHER_SWIFT_FLAGS=$(inherited) -DTS_PUSH_COVERAGE',
      '-jobs',
      '4',
      '-quiet'
    ],
    { stdio: 'inherit' }
  )
  const simctl = (...args) =>
    execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' }).trim()
  simctl('install', simulator, product)
  try {
    execFileSync(command[0], command.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, TS_TAB_APP_ID: appId }
    })
    // The existing instrumented AppDelegate flushes the application's LLVM counters on background.
    simctl('launch', simulator, 'com.apple.Preferences')
    const data = simctl('get_app_container', simulator, appId, 'data')
    const tmp = join(data, 'tmp')
    const findProfiles = () =>
      readdirSync(tmp)
        .filter(name => /^push-\d+\.profraw$/.test(name))
        .map(name => join(tmp, name))
    let profiles = findProfiles()
    const deadline = Date.now() + 5000
    while (!profiles.length && Date.now() < deadline) {
      await delay(100)
      profiles = findProfiles()
    }
    return profileCounts(
      join(product, 'TeamStation'),
      profiles,
      nativeFiles(base),
      directory
    )
  } finally {
    simctl('uninstall', simulator, appId)
  }
}

export function nativeFiles(base) {
  const files = execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      base,
      '--',
      'ios/TeamStation/*.mm'
    ],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter(Boolean)
  if (!files.length)
    throw new Error('No changed Objective-C++ files to measure')
  return files
}
