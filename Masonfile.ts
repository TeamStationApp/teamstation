import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Setup, Stage, WorkflowBuilder } from '@mason/types'

// TeamStation for iOS on the Nomac pool and for Android on the DigitalOcean
// Linux pool. The iOS archive signs an ad hoc build with the master's Apple
// distribution certificate and publishes it, so a registered device can
// install it. A master build then re-signs that IPA with the App Store
// profile and uploads it to TestFlight. Other branches leave that stage
// skipped. The Android release is compiled on Linux, then signed on the node
// labelled android-signing, which provides teamstation-sign-release-apk, and
// published from there. One platform failing leaves the other running.
//
// The `seat` parameter picks the server the app talks to. A development seat
// N points the app at https://developN.teamstation.app. Left at `production`,
// a master build keeps the app's own server, and every other branch points
// at https://develop.teamstation.app. Only a master build of production goes
// to TestFlight.
//
// `master` publishes `app.teamstation.app`. Any other branch, and any build
// aimed at a development seat, publishes `app.teamstation.develop` under the
// name TeamStation Develop, so it installs beside the stable app. The source
// tree keeps the stable id; the build rewrites it, the way Edge's develop
// build does.

export const STABLE_APP = 'app.teamstation.app'
export const DEVELOP_APP = 'app.teamstation.develop'
export const DEVELOP_DISPLAY_NAME = 'TeamStation Develop'
const DEVELOP_ORIGIN = 'https://develop.teamstation.app'
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
// The same shape ctx.apple.archive and ctx.apple.resign accept.
const versionPattern = /^[0-9]+(\.[0-9]+){0,2}$/

/** Which app id this run publishes. Master stays stable; every other branch and every seat does not. */
export function appIdOf(
  input: { branch?: string; seat?: string } = {}
): string {
  const branch =
    input.branch == null || input.branch === '' ? 'master' : input.branch
  const seat =
    input.seat == null || input.seat === '' ? 'production' : input.seat
  if (branch !== 'master' || seat !== 'production') return DEVELOP_APP
  return STABLE_APP
}

function developRoot(ctx: { workspace?: string }): string {
  const root = ctx.workspace
  if (root == null || root === '') {
    throw new Error('A develop build needs its workspace to set the app id')
  }
  return root
}

function runApp(ctx: {
  run?: { branch?: string; params?: { seat?: unknown } }
}): string {
  const seat = ctx.run?.params?.seat
  return appIdOf({
    branch: ctx.run?.branch,
    seat: typeof seat === 'string' ? seat : undefined
  })
}

/**
 * Rewrites the checked-in stable id to the develop app. A second call finds
 * the develop id already written and leaves the tree alone. A stable build
 * does not call this.
 */
export function applyDevelopIdentity(root: string): void {
  const rewrite = (file: string, from: string, to: string): void => {
    const full = path.join(root, file)
    let text: string
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      throw new Error(`${file} is missing ${from}`)
    }
    if (!text.includes(from)) {
      if (text.includes(to)) return
      throw new Error(`${file} is missing ${from}`)
    }
    writeFileSync(full, text.replaceAll(from, to))
  }
  rewrite(
    'android/app/build.gradle',
    'applicationId "app.teamstation.app"',
    `applicationId "${DEVELOP_APP}"`
  )
  rewrite(
    'android/app/src/main/res/values/strings.xml',
    '<string name="app_name">TeamStation</string>',
    `<string name="app_name">${DEVELOP_DISPLAY_NAME}</string>`
  )
  rewrite(
    'ios/TeamStation.xcodeproj/project.pbxproj',
    'PRODUCT_BUNDLE_IDENTIFIER = app.teamstation.app;',
    `PRODUCT_BUNDLE_IDENTIFIER = ${DEVELOP_APP};`
  )
  rewrite(
    'ios/TeamStation.xcodeproj/project.pbxproj',
    'PRODUCT_NAME = TeamStation;',
    `PRODUCT_NAME = "${DEVELOP_DISPLAY_NAME}";`
  )
  rewrite(
    'ios/TeamStation/Info.plist',
    '<key>CFBundleDisplayName</key>\n\t<string>TeamStation</string>',
    `<key>CFBundleDisplayName</key>\n\t<string>${DEVELOP_DISPLAY_NAME}</string>`
  )
  rewrite(
    'ios/TeamStation/Info.plist',
    '<key>CFBundleURLName</key>\n\t\t\t<string>app.teamstation.app</string>',
    `<key>CFBundleURLName</key>\n\t\t\t<string>${DEVELOP_APP}</string>`
  )
}

export function setup(m: Setup): void {
  m.apiVersion(1)
  const app = appIdOf({
    branch: m.branch,
    seat: typeof m.params?.seat === 'string' ? m.params.seat : undefined
  })
  m.buildNumber(app, { format: 'YYMMDDCC', timeZone: 'America/Los_Angeles' })
  m.workflow(
    'build',
    {
      params: {
        seat: {
          type: 'choice',
          choices: ['production', '1', '2', '3', '4', '5', '6', '7', '8'],
          default: 'production'
        }
      }
    },
    w => {
      buildStages(w, app)
    }
  )
}

function buildStages(w: WorkflowBuilder, app: string): void {
  w.parallel(
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
          apple: { distribution: 'adHoc', app },
          publishes: [app],
          buildNumbers: [app],
          cache: [{ key: 'npm', paths: ['~/.npm'] }],
          run: buildIos
        },
        {
          name: 'release',
          on: APPLE,
          timeout: '2h',
          // package.json is the short version. A shallow checkout reads it;
          // this stage re-signs the stashed IPA and does not compile.
          checkout: { depth: 1 },
          when: { branch: ['master'], params: { seat: 'production' } },
          apple: { distribution: 'appStore', app: STABLE_APP },
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
          publishes: [app],
          buildNumbers: [app],
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
          publishes: [app],
          buildNumbers: [app],
          run: signAndroid
        }
      ]
    },
    { failFast: false }
  )
}

/**
 * The environment that points the app at this run's server. Babel inlines
 * `TS_API_BASE_URL` into the bundle (`src/app/native/config.ts`). A master
 * build of production sets nothing and keeps the app's own default. Any
 * other branch, left on production, points at the standing develop server.
 * A development seat points at that seat, and its sign-in links use the
 * same host.
 */
export function seatEnvironment(
  ctx: Pick<Stage, 'run'>
): Record<string, string> {
  const seat = ctx.run.params?.seat ?? 'production'
  const branch = ctx.run.branch
  if (seat === 'production') {
    if (branch == null || branch === '' || branch === 'master') return {}
    return {
      TS_API_BASE_URL: `${DEVELOP_ORIGIN}/api/v1`,
      TS_APP_ORIGIN: DEVELOP_ORIGIN
    }
  }
  if (typeof seat !== 'string' || !/^[1-8]$/.test(seat)) {
    throw new Error(`Unknown seat ${String(seat)}`)
  }
  const origin = `https://develop${seat}.teamstation.app`
  return {
    TS_API_BASE_URL: `${origin}/api/v1`,
    TS_APP_ORIGIN: origin
  }
}

/**
 * What the about screen shows. Mason checks the pinned commit out detached, so
 * reading the git branch names it "detached", and a missing build number is
 * "development". The native build number and the run's branch go in instead.
 */
export function provenanceEnvironment(
  ctx: Pick<Stage, 'run'>,
  version: string,
  buildNumber: string
): Record<string, string> {
  const { branch, commit } = ctx.run
  if (branch == null || branch === '' || commit == null || commit === '') {
    throw new Error('The build has no branch or commit to record')
  }
  return {
    TS_BUILD_INFO: JSON.stringify({
      app: 'TeamStation',
      version,
      buildNumber,
      branch,
      commit,
      builtAt: new Date().toISOString()
    })
  }
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
  const app = runApp(ctx)
  if (app === DEVELOP_APP) applyDevelopIdentity(developRoot(ctx))
  // The ExpoModulesJSI slice is a nested xcodebuild with a clean environment,
  // so the archive setting below does not apply to it.
  await ctx.sh('node scripts/deploy/patchExpoModulesJsi.mjs')
  await ctx.sh('pod install', { cwd: 'ios' })
  const build = ctx.getBuildNumber(app)
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
      PATH: `${rustRoot}/cargo/bin:${process.env.PATH ?? ''}`,
      ...seatEnvironment(ctx),
      ...provenanceEnvironment(ctx, version, build)
    }
  })
  if (archived.ipa == null) throw new Error('No IPA was exported')
  await ctx.stash('ios-adhoc', relativeIpa(ctx, archived.ipa))
  await ctx.artifacts.save('ios-ipa', archived.ipa)
  await ctx.artifacts.save('ios-dsym', archived.dsyms)
  await ctx.publish({ app, platform: 'ios', path: archived.ipa })
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
  const app = runApp(ctx)
  if (app === DEVELOP_APP) applyDevelopIdentity(developRoot(ctx))
  const build = ctx.getBuildNumber(app)
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
        ...seatEnvironment(ctx),
        ...provenanceEnvironment(ctx, version, build),
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
  await ctx.publish({ app: runApp(ctx), platform: 'android', path: apk })
}
