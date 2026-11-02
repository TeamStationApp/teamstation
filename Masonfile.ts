import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { Setup, Stage } from '@mason/types'

// Pushes to master and develop build. Every other branch builds when someone
// requests a run. The iOS archive on Nomac uses the ad hoc profile, for every
// branch. A master build then re-signs that IPA with the distribution profile
// and certificate and uploads it to TestFlight; that stage runs on the same
// node as Android signing. Android is compiled on the Linux pool. Every
// branch's APK is signed with the release keystore on the node labelled
// android-signing, which is the only node that has it. One platform failing
// leaves the other running.

const APP = 'app.teamstation.app'
const IOS = { type: 'nomac', os: 'macos', arch: 'arm64' } as const
const ANDROID = { type: 'do-linux', os: 'linux', arch: 'x64' } as const
const SIGN = {
  type: 'macos-arm64',
  os: 'macos',
  arch: 'arm64',
  labels: ['android-signing']
} as const
const TESTFLIGHT_GROUP = 'TeamStation testers'
// The same shape ctx.apple.archive and ctx.apple.resign accept.
const versionPattern = /^[0-9]+(\.[0-9]+){0,2}$/

export function setup(m: Setup): void {
  m.apiVersion(1)
  m.buildNumber(APP, { format: 'YYMMDDCC', timeZone: 'America/Los_Angeles' })
  // Written out as literals so the master can read them without running setup.
  m.workflow(
    'build',
    {
      triggers: [
        { push: true, branches: ['master', 'develop'] },
        { request: true }
      ]
    },
    () => {}
  )
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
          on: SIGN,
          timeout: '2h',
          // package.json is the short version. A shallow checkout reads it;
          // this stage re-signs the stashed IPA and does not compile.
          checkout: { depth: 1 },
          when: { branch: ['master'] },
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
}

function workspacePath(ctx: Stage, name: string): string {
  const root = ctx.workspace
  if (root == null || root === '') return name
  return path.join(root, name)
}

/** The version every store build publishes, taken from package.json. */
function appVersion(ctx: Stage): string {
  const parsed: { version?: unknown } = JSON.parse(
    readFileSync(workspacePath(ctx, 'package.json'), 'utf8')
  )
  const version = parsed.version
  if (typeof version !== 'string' || !versionPattern.test(version)) {
    throw new Error(
      'package.json version must be one to three numeric components'
    )
  }
  return version
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
  const version = appVersion(ctx)
  const rustRoot = `${process.env.HOME}/.mason/tools/rust/1.98.0`
  const archived = await ctx.apple.archive({
    workspace: 'ios/TeamStation.xcworkspace',
    scheme: 'TeamStation',
    configuration: 'Release',
    version,
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

async function uploadAppStore(
  ctx: Stage,
  ipaPath: string,
  buildNumber?: string
): Promise<void> {
  const { ipa } = await ctx.apple.resign({
    path: ipaPath,
    version: appVersion(ctx),
    ...(buildNumber == null ? {} : { buildNumber })
  })
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

export async function compileAndroid(ctx: Stage): Promise<void> {
  await install(ctx)
  const build = ctx.getBuildNumber(APP)
  const version = appVersion(ctx)
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
  // The checked-in release config leaves versionCode at 1 and versionName
  // at 1.0. The init script sets this run's number and package.json's version.
  await ctx.sh(
    [
      "cat > mason-version.gradle << 'EOF'",
      'gradle.beforeProject { project ->',
      "  project.plugins.withId('com.android.application') {",
      "    project.extensions.getByName('androidComponents').finalizeDsl { android ->",
      "      android.defaultConfig.versionCode = Integer.parseInt(System.getenv('MASON_BUILD_NUMBER'))",
      "      android.defaultConfig.versionName = System.getenv('MASON_APP_VERSION')",
      '    }',
      '  }',
      '}',
      'EOF',
      './gradlew --no-daemon --init-script mason-version.gradle :app:assembleRelease'
    ].join('\n'),
    {
      cwd: 'android',
      env: {
        ...rustEnv,
        MASON_BUILD_NUMBER: build,
        MASON_APP_VERSION: version
      }
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
