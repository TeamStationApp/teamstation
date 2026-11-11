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
        'build'
      ]
    : ['app:assembleRelease', '-PreactNativeArchitectures=arm64-v8a']
const result = spawnSync(command, args, {
  cwd: platform === 'android' ? 'android' : '.',
  env,
  stdio: 'inherit'
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
if (platform === 'android') {
  mkdirSync(directory, { recursive: true })
  copyFileSync(
    'android/app/build/outputs/apk/release/app-release.apk',
    resolve(directory, 'app-release.apk')
  )
}
console.log(
  platform === 'ios'
    ? `Fixture: ${resolve(directory, 'Build/Products/Release-iphonesimulator/TeamStation.app')}`
    : `Fixture: ${resolve(directory, 'app-release.apk')}`
)
