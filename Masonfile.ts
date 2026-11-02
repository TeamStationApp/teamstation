import type { Setup, Stage } from '@mason/types'

// TeamStation for iOS on the Nomac pool and for Android on the DigitalOcean
// Linux pool. The iOS archive signs an ad hoc build with the master's Apple
// distribution certificate and publishes it, so a registered device can
// install it. The release stage re-signs that IPA with the App Store profile
// and uploads it to TestFlight. The Android release is compiled on Linux,
// then signed on the node labelled android-signing, which provides
// teamstation-sign-release-apk, and published from there. One platform
// failing leaves the other running.

const APP = 'app.teamstation.app'
const IOS = { type: 'nomac', os: 'macos', arch: 'arm64' } as const
const ANDROID = { type: 'do-linux', os: 'linux', arch: 'x64' } as const
const SIGN = {
  type: 'macos-arm64',
  os: 'macos',
  arch: 'arm64',
  labels: ['android-signing']
} as const
const APPLE = { type: 'macos-arm64', os: 'macos', arch: 'arm64' } as const
const TESTFLIGHT_GROUP = 'TeamStation testers'

export function setup(m: Setup): void {
  m.apiVersion(1)
  m.buildNumber(APP, { format: 'YYMMDDCC', timeZone: 'America/Los_Angeles' })
  m.parallel(
    'build',
    {
      ios: [
        {
          name: 'archive',
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
        {
          name: 'release',
          on: APPLE,
          timeout: '2h',
          checkout: false,
          apple: { distribution: 'appStore', app: APP },
          run: releaseIos
        }
      ],
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
  // The last successful ad hoc IPA, re-signed for the App Store. This uploads
  // a build that already compiled, so it does not archive again.
  m.workflow('release', {}, w => {
    w.stage('ios', {
      on: APPLE,
      timeout: '2h',
      checkout: false,
      apple: { distribution: 'appStore', app: APP },
      run: shipIos
    })
  })
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
  // The ExpoModulesJSI slice is a nested xcodebuild with a clean environment,
  // so the archive setting below does not apply to it.
  await ctx.sh('node scripts/deploy/patchExpoModulesJsi.mjs')
  await ctx.sh('pod install', { cwd: 'ios' })
  const build = ctx.getBuildNumber(APP)
  const rustRoot = `${process.env.HOME}/.mason/tools/rust/1.98.0`
  const archived = await ctx.apple.archive({
    workspace: 'ios/TeamStation.xcworkspace',
    scheme: 'TeamStation',
    configuration: 'Release',
    buildNumber: build,
    // Xcode 27 treats a Swift explicit-module compile that exits 0 with no
    // output as a failed archive. Turning explicit modules off avoids it.
    xcargs: ['SWIFT_ENABLE_EXPLICIT_MODULES=NO'],
    env: {
      CARGO_HOME: `${rustRoot}/cargo`,
      RUSTUP_HOME: `${rustRoot}/rustup`,
      PATH: `${rustRoot}/cargo/bin:${process.env.PATH ?? ''}`
    }
  })
  if (archived.ipa == null) throw new Error('No IPA was exported')
  await ctx.stash('ios-adhoc', relativeIpa(ctx, archived.ipa))
  await ctx.artifacts.save('ios-ipa', archived.ipa)
  await ctx.artifacts.save('ios-dsym', archived.dsyms)
  await ctx.publish({ app: APP, platform: 'ios', path: archived.ipa })
}

function relativeIpa(ctx: Stage, file: string): string {
  const root = ctx.workspace
  if (root == null || root === '') return file
  const prefix = root.endsWith('/') ? root : `${root}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

async function uploadAppStore(ctx: Stage, path: string): Promise<void> {
  const { ipa } = await ctx.apple.resign({ path })
  await ctx.artifacts.save('ios-appstore', ipa)
  await ctx.apple.testflight({
    path: ipa,
    whatToTest: 'TeamStation production build.',
    groups: [TESTFLIGHT_GROUP],
    usesNonExemptEncryption: false
  })
}

export async function releaseIos(ctx: Stage): Promise<void> {
  await ctx.unstash('ios-adhoc')
  const packed = await ctx.fs.glob('**/*.ipa')
  const input = packed[0]
  if (input == null) throw new Error('No ad hoc IPA was stashed')
  await uploadAppStore(ctx, input)
}

export async function shipIos(ctx: Stage): Promise<void> {
  const files = await ctx.artifacts.fetch(
    {
      workflow: 'build',
      branch: ctx.run.branch,
      status: 'success',
      name: 'ios-ipa'
    },
    'fetched'
  )
  const input = files.find(file => file.endsWith('.ipa'))
  if (input == null) throw new Error('The iOS artifact has no IPA')
  await uploadAppStore(ctx, input)
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
  // The checked-in release config leaves versionCode at 1. The init script
  // sets the run's number the way the deploy build does, without its keystore.
  await ctx.sh(
    [
      "cat > mason-version.gradle << 'EOF'",
      'gradle.beforeProject { project ->',
      "  project.plugins.withId('com.android.application') {",
      "    project.extensions.getByName('androidComponents').finalizeDsl { android ->",
      "      android.defaultConfig.versionCode = Integer.parseInt(System.getenv('MASON_BUILD_NUMBER'))",
      '    }',
      '  }',
      '}',
      'EOF',
      './gradlew --no-daemon --init-script mason-version.gradle :app:assembleRelease'
    ].join('\n'),
    {
      cwd: 'android',
      env: { ...rustEnv, MASON_BUILD_NUMBER: build }
    }
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
