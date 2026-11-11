// Build isolated fixture apps with the native toolchains' supported ENTRY_FILE.
// No source rewriting, device discovery, installation, or production signing.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [platform, kind = 'gallery'] = process.argv.slice(2)
if (
  !['ios', 'android'].includes(platform) ||
  !['gallery', 'principal'].includes(kind)
)
  throw new Error(
    'Usage: node scripts/build-button-icons-native.mjs ios|android gallery|principal'
  )
const directory = process.env.TS_ICON_FIXTURE_DIR
if (!directory) throw new Error('Supply TS_ICON_FIXTURE_DIR for build output')
const entry =
  kind === 'gallery'
    ? 'src/test/buttonIcons.gallery.native.tsx'
    : 'src/test/buttonIcons.native.tsx'
const abi =
  process.env.TS_ICON_ANDROID_ABI ??
  (process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64')
if (!['arm64-v8a', 'x86_64'].includes(abi))
  throw new Error('TS_ICON_ANDROID_ABI must be arm64-v8a or x86_64')
const env = { ...process.env, ENTRY_FILE: entry }
const command = platform === 'ios' ? 'xcodebuild' : './gradlew'
const args =
  platform === 'ios'
    ? [
        '-workspace',
        'ios/TeamStation.xcworkspace',
        '-scheme',
        'TeamStation',
        '-configuration',
        'Release',
        '-sdk',
        'iphonesimulator',
        '-destination',
        'generic/platform=iOS Simulator',
        '-derivedDataPath',
        resolve(directory),
        'CODE_SIGNING_ALLOWED=NO',
        'PRODUCT_BUNDLE_IDENTIFIER=app.teamstation.app.icons',
        'build'
      ]
    : [
        '-I',
        '../scripts/button-icons-fixture.gradle',
        'app:assembleIconFixture',
        `-PreactNativeArchitectures=${abi}`
      ]
const result = spawnSync(command, args, {
  cwd: platform === 'android' ? 'android' : '.',
  env,
  stdio: 'inherit'
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
if (platform === 'ios') {
  const label = spawnSync(
    '/usr/libexec/PlistBuddy',
    [
      '-c',
      'Set :CFBundleDisplayName Icon Fixture',
      resolve(
        directory,
        'Build/Products/Release-iphonesimulator/TeamStation.app/Info.plist'
      )
    ],
    { stdio: 'inherit' }
  )
  if (label.error) throw label.error
  if (label.status !== 0) process.exit(label.status ?? 1)
}
if (platform === 'android') {
  mkdirSync(directory, { recursive: true })
  copyFileSync(
    'android/app/build/outputs/apk/iconFixture/app-iconFixture.apk',
    resolve(directory, 'app-iconFixture.apk')
  )
}
console.log(
  platform === 'ios'
    ? `Fixture: ${resolve(directory, 'Build/Products/Release-iphonesimulator/TeamStation.app')}`
    : `Fixture: ${resolve(directory, 'app-iconFixture.apk')}`
)

if (platform === 'android')
  console.log(`Application ID: app.teamstation.app.icons; ABI: ${abi}`)

if (platform === 'ios')
  console.log(
    'Application ID: app.teamstation.app.icons; display name: Icon Fixture'
  )
