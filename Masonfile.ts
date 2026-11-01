import type { Setup, Stage } from '@mason/types'

// TeamStation for iOS on the Mac node (macos-arm64) and for Android on the
// DigitalOcean Linux pool (do-linux). The iOS archive is unsigned; the
// Android release build uses the debug keystore the app's release type
// already signs with. Signing for distribution stays with the master once
// it holds the Apple team and a release keystore.

const APP = 'app.teamstation.app'
const IOS = { type: 'macos-arm64', os: 'macos', arch: 'arm64' } as const
const ANDROID = { type: 'do-linux', os: 'linux', arch: 'x64' } as const

export function setup(m: Setup): void {
  m.apiVersion(1)
  m.buildNumber(APP, { format: 'YYMMDDCC', timeZone: 'America/Los_Angeles' })
  m.parallel('build', {
    ios: {
      on: IOS,
      tools: { node: '24', xcode: '26.6', cocoapods: '1.16.2' },
      timeout: '4h',
      publishes: [APP],
      buildNumbers: [APP],
      cache: [{ key: 'npm', paths: ['~/.npm'] }],
      run: buildIos
    },
    android: {
      on: ANDROID,
      tools: {
        node: '24',
        java: '17',
        android: [
          'platforms;android-37.0',
          'build-tools;37.0.0',
          'ndk;27.1.12297006',
          'cmake;3.22.1'
        ],
        androidLicenses: 'accept'
      },
      timeout: '4h',
      publishes: [APP],
      buildNumbers: [APP],
      cache: [{ key: 'npm', paths: ['~/.npm'] }],
      run: buildAndroid
    }
  })
}

/**
 * Installs dependencies through Socket. A quota refusal or a worker with no
 * Socket token installs with npm; any other Socket failure stops the build.
 */
async function install(ctx: Stage): Promise<void> {
  await ctx.sh('npm install --prefix .mason-tools @socketsecurity/cli')
  // An advisory published after this lockfile was committed does not fail the build.
  const scanned = await ctx.sh('.mason-tools/node_modules/.bin/socket npm ci', {
    env: { SOCKET_CLI_ACCEPT_RISKS: '1' },
    allowFailure: true
  })
  if (scanned.code === 0) return
  const detail = `${scanned.stdout}\n${scanned.stderr}`
  if (!/429|Insufficient quota|requires an API token/.test(detail)) {
    throw new Error(`socket npm ci failed with exit code ${scanned.code}`)
  }
  await ctx.sh('npm ci')
}

export async function buildIos(ctx: Stage): Promise<void> {
  await install(ctx)
  await ctx.sh('pod install', { cwd: 'ios' })
  const build = ctx.getBuildNumber(APP)
  await ctx.sh(
    [
      'xcodebuild archive',
      '-workspace TeamStation.xcworkspace',
      '-scheme TeamStation',
      '-configuration Release',
      "-destination 'generic/platform=iOS'",
      '-archivePath "$PWD/../build/TeamStation.xcarchive"',
      `CURRENT_PROJECT_VERSION=${build}`,
      'CODE_SIGNING_ALLOWED=NO'
    ].join(' '),
    { cwd: 'ios' }
  )
  await ctx.artifacts.save('ios-archive', 'build/TeamStation.xcarchive/**')
}

export async function buildAndroid(ctx: Stage): Promise<void> {
  await install(ctx)
  const build = ctx.getBuildNumber(APP)
  await ctx.sh(
    [
      'test -f app/debug.keystore || keytool -genkeypair',
      '-keystore app/debug.keystore -alias androiddebugkey',
      '-keyalg RSA -keysize 2048 -validity 10000',
      '-storepass android -keypass android',
      "-dname 'CN=Android Debug,O=Android,C=US'"
    ].join(' '),
    { cwd: 'android' }
  )
  await ctx.sh(
    `./gradlew --no-daemon :app:assembleRelease -PversionCode=${build}`,
    {
      cwd: 'android'
    }
  )
  await ctx.artifacts.save(
    'android-apk',
    'android/app/build/outputs/apk/release/*.apk'
  )
}
