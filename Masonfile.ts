import type { Setup, Stage } from '@mason/types'

// TeamStation for iOS on the Nomac pool and for Android on the DigitalOcean
// Linux pool. The iOS stage signs an ad hoc build with the master's Apple
// distribution certificate and publishes it, so a registered device can
// install it. The Android release is compiled on Linux, then signed on the
// node labelled android-signing, which provides teamstation-sign-release-apk,
// and published from there. One platform failing leaves the other running.

const APP = 'app.teamstation.app'
const IOS = { type: 'nomac', os: 'macos', arch: 'arm64' } as const
const ANDROID = { type: 'do-linux', os: 'linux', arch: 'x64' } as const
const SIGN = {
  type: 'macos-arm64',
  os: 'macos',
  arch: 'arm64',
  labels: ['android-signing']
} as const

export function setup(m: Setup): void {
  m.apiVersion(1)
  m.buildNumber(APP, { format: 'YYMMDDCC', timeZone: 'America/Los_Angeles' })
  m.parallel(
    'build',
    {
      ios: {
        on: IOS,
        // Nomac provides Xcode 27.0 and cannot install another version.
        // Rust is installed into the worker tools directory; the archive
        // environment points the Xcode script phase at that cargo.
        tools: {
          node: '24',
          xcode: '27.0',
          cocoapods: '1.16.2',
          rust: '1.98.0'
        },
        timeout: '6h',
        apple: { distribution: 'adHoc', app: APP },
        publishes: [APP],
        buildNumbers: [APP],
        cache: [{ key: 'npm', paths: ['~/.npm'] }],
        run: buildIos
      },
      android: [
        {
          name: 'compile',
          on: ANDROID,
          tools: {
            node: '24',
            java: '17',
            rust: '1.98.0',
            apt: ['build-essential'],
            android: [
              'platforms;android-37.0',
              'build-tools;37.0.0',
              'ndk;27.1.12297006',
              'cmake;3.22.1'
            ],
            androidLicenses: 'accept'
          },
          timeout: '6h',
          publishes: [APP],
          buildNumbers: [APP],
          cache: [{ key: 'npm', paths: ['~/.npm'] }],
          run: compileAndroid
        },
        {
          name: 'sign',
          on: SIGN,
          tools: {
            node: '24',
            java: '17',
            android: ['build-tools;37.0.0'],
            androidLicenses: 'accept'
          },
          timeout: '1h',
          publishes: [APP],
          buildNumbers: [APP],
          run: signAndroid
        }
      ]
    },
    { failFast: false }
  )
}

/**
 * Installs dependencies through Socket. A quota refusal or a worker with no
 * Socket token installs with npm; any other Socket failure stops the build.
 */
async function install(ctx: Stage): Promise<void> {
  await ctx.sh('npm install --prefix .mason-tools @socketsecurity/cli')
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
  const rustRoot = `${process.env.HOME}/.mason/tools/rust/1.98.0`
  const archived = await ctx.apple.archive({
    workspace: 'ios/TeamStation.xcworkspace',
    scheme: 'TeamStation',
    configuration: 'Release',
    buildNumber: build,
    env: {
      CARGO_HOME: `${rustRoot}/cargo`,
      RUSTUP_HOME: `${rustRoot}/rustup`,
      PATH: `${rustRoot}/cargo/bin:${process.env.PATH ?? ''}`
    }
  })
  if (archived.ipa == null) throw new Error('No IPA was exported')
  await ctx.artifacts.save('ios-ipa', archived.ipa)
  await ctx.artifacts.save('ios-dsym', archived.dsyms)
  await ctx.publish({ app: APP, platform: 'ios', path: archived.ipa })
}

export async function compileAndroid(ctx: Stage): Promise<void> {
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
  const rustRoot = `${process.env.HOME}/.mason/tools/rust/1.98.0`
  const rustEnv = {
    CARGO_HOME: `${rustRoot}/cargo`,
    RUSTUP_HOME: `${rustRoot}/rustup`,
    PATH: `${rustRoot}/cargo/bin:${process.env.PATH ?? ''}`
  }
  await ctx.sh('cargo install cargo-ndk', { env: rustEnv })
  await ctx.sh(
    `./gradlew --no-daemon :app:assembleRelease -PversionCode=${build}`,
    { cwd: 'android', env: rustEnv }
  )
  await ctx.stash(
    'android-release',
    'android/app/build/outputs/apk/release/*.apk'
  )
}

export async function signAndroid(ctx: Stage): Promise<void> {
  await ctx.unstash('android-release')
  await ctx.sh(
    '"$HOME/.local/bin/teamstation-sign-release-apk" android/app/build/outputs/apk/release'
  )
  const apks = await ctx.fs.glob('android/app/build/outputs/apk/release/*.apk')
  const apk = apks[0]
  if (apk == null) throw new Error('No release APK was signed')
  await ctx.artifacts.save('android-apk', apk)
  await ctx.publish({ app: APP, platform: 'android', path: apk })
}
