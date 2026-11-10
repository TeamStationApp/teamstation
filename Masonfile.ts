import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
export const TV_APP = 'app.teamstation.tv'
export const DEVELOP_APP = 'app.teamstation.develop'
export const DEVELOP_DISPLAY_NAME = 'TeamStation Develop'
export const DIRECTOR_APP = 'app.teamstation.director'
export const CAMERAMAN_APP = 'app.teamstation.cameraman'
export const DIRECTOR_DEVELOP_APP = 'app.teamstation.director-develop'
// A dot, not a hyphen: Android package names allow no hyphen, and Mason
// publishes an APK only under the app id that is its package.
export const CAMERAMAN_DEVELOP_APP = 'app.teamstation.cameraman.develop'
export const DIRECTOR_DEVELOP_NAME = 'Director Develop'
export const CAMERAMAN_DEVELOP_NAME = 'Cameraman Develop'
// The test control channel's URL schemes a develop build claims, so a flow's
// tsdirector:// or tscameraman:// link reaches the master build beside it.
export const DIRECTOR_DEVELOP_SCHEME = 'tsdirector-develop'
export const CAMERAMAN_DEVELOP_SCHEME = 'tscameraman-develop'
export const DISTRIBUTOR_APP = 'app.teamstation.distributor'
export const DISTRIBUTOR_DEVELOP_APP = 'app.teamstation.distributor-develop'
export const DISTRIBUTOR_NAME = 'TS Distributor'
export const DISTRIBUTOR_DEVELOP_NAME = 'Distributor Develop'
// The team of the field apps' Mason app records. The xcconfig carries it:
// -xcconfig overrides even Mason's own DEVELOPMENT_TEAM on the command line.
export const FIELD_TEAM = 'V4AK4X7A2V'
export const FIELD_VERSION = '1.0'
const DEVELOP_ORIGIN = 'https://develop.teamstation.app'
const CAMERAMAN_APK_DIR =
  'mobile/apps/tsCameramanAndroid/app/build/outputs/apk/release'
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

/** A master run, or one that names no branch, which stands in for master. */
export function isMasterBranch(branch: string | undefined): boolean {
  return branch == null || branch === '' || branch === 'master'
}

/**
 * Replaces `from` with `to` in a file below root. A file that already has
 * `to` and no `from` was rewritten before and is left alone.
 */
function rewriteOnce(
  root: string,
  file: string,
  from: string,
  to: string
): void {
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

/** Which app id this run publishes. Master stays stable; every other branch and every seat does not. */
export function appIdOf(
  input: { branch?: string; seat?: string } = {}
): string {
  const seat =
    input.seat == null || input.seat === '' ? 'production' : input.seat
  if (!isMasterBranch(input.branch) || seat !== 'production') return DEVELOP_APP
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
    rewriteOnce(root, file, from, to)
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
  m.workflow('soak-artifacts', { triggers: [{ request: true }] }, w => {
    w.stage('retrieve', { on: SIGN, tools: { node: '24' }, run: retrieveSoakArtifacts })
  })
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
  m.buildNumber(TV_APP, { format: 'YYMMDDCC', timeZone: 'America/Los_Angeles' })
  // Explicit request-only triggers exclude this workflow from branch polling.
  m.workflow(
    'tvos',
    {
      triggers: [{ request: true }],
      params: {
        seat: {
          type: 'choice',
          choices: ['production', '1', '2', '3', '4', '5', '6', '7', '8'],
          default: 'production'
        }
      }
    },
    w => {
      w.stage('archive', {
        on: IOS,
        tools: { node: '24', xcode: '27.0', cocoapods: '1.16.2' },
        timeout: '6h',
        apple: { distribution: 'adHoc', app: TV_APP, platform: 'tvos' },
        publishes: [TV_APP],
        buildNumbers: [TV_APP],
        cache: [{ key: 'npm', paths: ['~/.npm'] }],
        run: buildTv
      })
    }
  )
  // Request-only, so a push of master or develop does not start these.
  // Master installs the stable app. Develop and every other branch install
  // the develop app, beside a master build.
  const directorApp = fieldAppId(DIRECTOR_APP, DIRECTOR_DEVELOP_APP, m.branch)
  const cameramanApp = fieldAppId(
    CAMERAMAN_APP,
    CAMERAMAN_DEVELOP_APP,
    m.branch
  )
  m.buildNumber(directorApp, {
    format: 'YYMMDDCC',
    timeZone: 'America/Los_Angeles'
  })
  m.workflow(
    'director',
    { triggers: [{ request: true }], timeout: '8h' },
    w => {
      w.stage('archive', {
        on: APPLE,
        tools: { node: '24', xcode: '26.6', brew: ['xcodegen'] },
        timeout: '6h',
        apple: { distribution: 'adHoc', app: directorApp },
        publishes: [directorApp],
        buildNumbers: [directorApp],
        run: archiveDirector
      })
    }
  )
  m.buildNumber(cameramanApp, {
    format: 'YYMMDDCC',
    timeZone: 'America/Los_Angeles'
  })
  m.workflow(
    'cameraman',
    { triggers: [{ request: true }], timeout: '8h' },
    w => {
      w.parallel(
        'build',
        {
          ios: [
            {
              name: 'archive',
              on: APPLE,
              tools: { node: '24', xcode: '26.6', brew: ['xcodegen'] },
              timeout: '6h',
              apple: { distribution: 'adHoc', app: cameramanApp },
              publishes: [cameramanApp],
              buildNumbers: [cameramanApp],
              run: archiveCameraman
            }
          ],
          android: [
            {
              name: 'compile',
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
              timeout: '6h',
              buildNumbers: [cameramanApp],
              run: compileCameraman
            },
            {
              // The compile node's keystore is its own, so the release key
              // signs here and every build installs over the one before.
              name: 'sign',
              on: SIGN,
              tools: {
                node: '24',
                java: '17',
                android: ['build-tools;37.0.0'],
                androidLicenses: 'accept'
              },
              timeout: '1h',
              publishes: [cameramanApp],
              buildNumbers: [cameramanApp],
              run: signCameraman
            }
          ]
        },
        { failFast: false }
      )
    }
  )
  const distributorApp = fieldAppId(
    DISTRIBUTOR_APP,
    DISTRIBUTOR_DEVELOP_APP,
    m.branch
  )
  m.buildNumber(distributorApp, {
    format: 'YYMMDDCC',
    timeZone: 'America/Los_Angeles'
  })
  m.workflow(
    'distributor',
    { triggers: [{ request: true }], timeout: '8h' },
    w => {
      w.stage('archive', {
        on: APPLE,
        tools: { node: '24', xcode: '26.6', brew: ['xcodegen'] },
        timeout: '6h',
        apple: {
          distribution: 'development',
          app: distributorApp,
          platform: 'macos'
        },
        publishes: [distributorApp],
        buildNumbers: [distributorApp],
        run: archiveDistributor
      })
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
 * build explicitly names production. Any
 * other branch, left on production, points at the standing develop server.
 * A development seat keeps its API and shares the develop app-link host.
 */
export function seatEnvironment(
  ctx: Pick<Stage, 'run'>
): Record<string, string> {
  const seat = ctx.run.params?.seat ?? 'production'
  const branch = ctx.run.branch
  if (seat === 'production') {
    if (isMasterBranch(branch) || branch === 'codex/streamingSoakRerun')
      return {
        TS_API_BASE_URL: 'https://app.teamstation.app/api/v1',
        TS_APP_ORIGIN: 'https://app.teamstation.app'
      }
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
    TS_APP_ORIGIN: DEVELOP_ORIGIN
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
async function install(ctx: Stage, cwd?: string): Promise<void> {
  await ctx.sh('npm install --prefix .mason-tools @socketsecurity/cli', { cwd })
  const scanned = await ctx.sh('.mason-tools/node_modules/.bin/socket npm ci', {
    cwd,
    env: { SOCKET_CLI_ACCEPT_RISKS: '1' },
    allowFailure: true
  })
  if (scanned.code === 0) return
  const detail = `${scanned.stdout}\n${scanned.stderr}`
  if (!/429|Insufficient quota|requires an API token/.test(detail)) {
    throw new Error(`socket npm ci failed with exit code ${scanned.code}`)
  }
  await ctx.sh('npm ci', { cwd })
}

/** A standalone Apple TV download; never automatically submitted to TestFlight. */
export async function buildTv(ctx: Stage): Promise<void> {
  const environment = seatEnvironment(ctx)
  const api = environment.TS_API_BASE_URL
  await install(ctx)
  await install(ctx, 'appletv')
  await ctx.sh('pod install', { cwd: 'appletv/ios' })
  const archived = await ctx.apple.archive({
    workspace: 'appletv/ios/TeamStationTV.xcworkspace',
    scheme: 'TeamStationTV',
    configuration: 'Release',
    version: appVersion(ctx),
    buildNumber: ctx.getBuildNumber(TV_APP),
    // Match the iOS archive's workaround for Xcode 27 Swift module failures.
    xcargs: [
      'SWIFT_ENABLE_EXPLICIT_MODULES=NO',
      `TV_API_BASE_URL=${api}`,
      `TV_APP_ORIGIN=${environment.TS_APP_ORIGIN}`
    ]
  })
  if (archived.ipa == null) throw new Error('No tvOS IPA was exported')
  await ctx.artifacts.save('tvos-ipa', archived.ipa)
  await ctx.artifacts.save('tvos-dsym', archived.dsyms)
  await ctx.publish({ app: TV_APP, platform: 'tvos', path: archived.ipa })
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
    xcargs: [
      'SWIFT_ENABLE_EXPLICIT_MODULES=NO',
      `TS_APP_LINK_HOST=${new URL(seatEnvironment(ctx).TS_APP_ORIGIN).host}`,
      'TS_APP_ENTITLEMENTS=TeamStation/TeamStation.entitlements'
    ],
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

/**
 * Master keeps the stable app id. Develop and every other branch use the
 * develop id, so that install sits beside a master build.
 */
export function fieldAppId(
  stable: string,
  developId: string,
  branch: string | undefined
): string {
  if (isMasterBranch(branch)) return stable
  return developId
}

/**
 * Rewrites a develop or branch build's bundle id and the name shown on the
 * home screen. PRODUCT_NAME stays, so the executable, the module and the test
 * hosts that name `TS Director.app` and `TS Cameraman.app` keep their names. A second call finds the develop id already written and leaves
 * the tree alone. A master build does not call this.
 */
export function applyFieldDevelopIdentity(
  root: string,
  which: 'director' | 'cameraman' | 'distributor'
): void {
  const rewrite = (file: string, from: string, to: string): void => {
    rewriteOnce(root, file, from, to)
  }
  if (which === 'distributor') {
    // A Mac installs the app under its PRODUCT_NAME, so the develop build
    // takes its own name to sit beside TS Distributor.app.
    for (const [from, to] of [
      [
        `PRODUCT_BUNDLE_IDENTIFIER: ${DISTRIBUTOR_APP}\n`,
        `PRODUCT_BUNDLE_IDENTIFIER: ${DISTRIBUTOR_DEVELOP_APP}\n`
      ],
      [
        `PRODUCT_NAME: ${DISTRIBUTOR_NAME}\n`,
        `PRODUCT_NAME: ${DISTRIBUTOR_DEVELOP_NAME}\n`
      ],
      [
        `INFOPLIST_KEY_CFBundleDisplayName: ${DISTRIBUTOR_NAME}\n`,
        `INFOPLIST_KEY_CFBundleDisplayName: ${DISTRIBUTOR_DEVELOP_NAME}\n`
      ]
    ])
      rewrite('mobile/apps/tsDistributor/project.yml', from, to)
    return
  }
  if (which === 'director') {
    rewrite(
      'mobile/apps/tsDirector/project.yml',
      'PRODUCT_BUNDLE_IDENTIFIER: app.teamstation.director\n',
      `PRODUCT_BUNDLE_IDENTIFIER: ${DIRECTOR_DEVELOP_APP}\n`
    )
    rewrite(
      'mobile/apps/tsDirector/App/Info.plist',
      '<key>CFBundleDisplayName</key>\n  <string>TS Director</string>',
      `<key>CFBundleDisplayName</key>\n  <string>${DIRECTOR_DEVELOP_NAME}</string>`
    )
    rewrite(
      'mobile/apps/tsDirector/App/Info.plist',
      '<string>app.teamstation.director.control</string>',
      `<string>${DIRECTOR_DEVELOP_APP}.control</string>`
    )
    rewrite(
      'mobile/apps/tsDirector/App/Info.plist',
      '<string>tsdirector</string>',
      `<string>${DIRECTOR_DEVELOP_SCHEME}</string>`
    )
    return
  }
  rewrite(
    'mobile/apps/tsCameraman/project.yml',
    'PRODUCT_BUNDLE_IDENTIFIER: app.teamstation.cameraman\n',
    `PRODUCT_BUNDLE_IDENTIFIER: ${CAMERAMAN_DEVELOP_APP}\n`
  )
  rewrite(
    'mobile/apps/tsCameraman/App/Info.plist',
    '<key>CFBundleDisplayName</key>\n  <string>TS Cameraman</string>',
    `<key>CFBundleDisplayName</key>\n  <string>${CAMERAMAN_DEVELOP_NAME}</string>`
  )
  rewrite(
    'mobile/apps/tsCameraman/App/Info.plist',
    '<string>app.teamstation.cameraman.control</string>',
    `<string>${CAMERAMAN_DEVELOP_APP}.control</string>`
  )
  rewrite(
    'mobile/apps/tsCameraman/App/Info.plist',
    '<string>tscameraman</string>',
    `<string>${CAMERAMAN_DEVELOP_SCHEME}</string>`
  )
  rewrite(
    'mobile/apps/tsCameramanAndroid/app/src/main/AndroidManifest.xml',
    'android:scheme="tscameraman"',
    `android:scheme="${CAMERAMAN_DEVELOP_SCHEME}"`
  )
  rewrite(
    'mobile/apps/tsCameramanAndroid/app/build.gradle.kts',
    'applicationId = "app.teamstation.cameraman"',
    `applicationId = "${CAMERAMAN_DEVELOP_APP}"`
  )
  rewrite(
    'mobile/apps/tsCameramanAndroid/app/src/main/res/values/strings.xml',
    '<string name="app_name">TS Cameraman</string>',
    `<string name="app_name">${CAMERAMAN_DEVELOP_NAME}</string>`
  )
}

/** The server a field app signs in to and reports to. Master stays on production. */
export function fieldOrigin(branch: string | undefined): string {
  if (isMasterBranch(branch)) return 'https://app.teamstation.app'
  return DEVELOP_ORIGIN
}

/**
 * The host a field app's sign-in links are mailed from, which opens that app:
 * the deployment's appLinks.json gives each one its own, and the server
 * answers that host's apple-app-site-association and assetlinks.json for it
 * alone. The develop ids and Distributor have none, so their builds ask for
 * ordinary web links.
 */
export const FIELD_LINK_ORIGINS: Readonly<Record<string, string>> = {
  [DIRECTOR_APP]: 'https://director.teamstation.app',
  [CAMERAMAN_APP]: 'https://cameraman.teamstation.app'
}

/**
 * Writes the gitignored clientConfig.json a field app's Xcode and Gradle
 * builds read for their team and the link host of the app id they publish.
 */
export function writeFieldClientConfig(appDir: string, app: string): void {
  const appOrigin = FIELD_LINK_ORIGINS[app]
  writeFileSync(
    path.join(appDir, 'clientConfig.json'),
    JSON.stringify({
      appleTeamId: FIELD_TEAM,
      ...(appOrigin == null ? {} : { appOrigin })
    }) + '\n',
    { mode: 0o600 }
  )
}

/**
 * The xcodebuild arguments every field archive takes: the
 * clientConfig.xcconfig scripts/clientConfig.mjs wrote for the app, which
 * names the team, the link host and the entitlements, as the app's own build
 * scripts pass it; and the server the app signs in to and reports to
 * (Info.plist's TSPrimaryHost), which the xcconfig does not carry.
 */
export function fieldLinkSettings(
  appDir: string,
  branch: string | undefined
): string[] {
  return [
    '-xcconfig',
    `${appDir}/clientConfig.xcconfig`,
    'SWIFT_ENABLE_EXPLICIT_MODULES=NO',
    `TS_PRIMARY_HOST=${new URL(fieldOrigin(branch)).host}`
  ]
}

async function archiveFieldApp(
  ctx: Stage,
  appDir: string,
  entitlements: string,
  project: string,
  scheme: string,
  app: string
): Promise<{ ipa: string; dsyms: string; build: string }> {
  const root = developRoot(ctx)
  writeFieldClientConfig(path.join(root, appDir), app)
  await ctx.sh(
    `node scripts/clientConfig.mjs ${appDir} --entitlements ${entitlements}`
  )
  const build = ctx.getBuildNumber(app)
  const archived = await ctx.apple.archive({
    project,
    scheme,
    configuration: 'Release',
    version: FIELD_VERSION,
    buildNumber: build,
    xcargs: fieldLinkSettings(appDir, ctx.run.branch)
  })
  if (archived.ipa == null) throw new Error('No IPA was exported')
  return { ipa: archived.ipa, dsyms: archived.dsyms, build }
}

export async function archiveDirector(ctx: Stage): Promise<void> {
  const app = fieldAppId(DIRECTOR_APP, DIRECTOR_DEVELOP_APP, ctx.run.branch)
  if (app === DIRECTOR_DEVELOP_APP)
    applyFieldDevelopIdentity(developRoot(ctx), 'director')
  // Absolute: bootstrap.sh changes directory, then looks up bootstrapNdi.sh
  // relative to the path it was started with.
  await ctx.sh('bash "$PWD/mobile/apps/tsDirector/scripts/bootstrap.sh"')
  const { ipa, dsyms, build } = await archiveFieldApp(
    ctx,
    'mobile/apps/tsDirector',
    'App/Director.entitlements',
    'mobile/apps/tsDirector/Director.xcodeproj',
    'Director',
    app
  )
  await ctx.artifacts.save('director-ipa', ipa)
  // The xcarchive is not kept, so these are what symbolicate a crash report.
  await ctx.artifacts.save('director-dsym', dsyms)
  await ctx.publish({
    app,
    platform: 'ios',
    path: ipa,
    version: FIELD_VERSION,
    buildNumber: build
  })
}

export async function archiveCameraman(ctx: Stage): Promise<void> {
  const app = fieldAppId(CAMERAMAN_APP, CAMERAMAN_DEVELOP_APP, ctx.run.branch)
  if (app === CAMERAMAN_DEVELOP_APP)
    applyFieldDevelopIdentity(developRoot(ctx), 'cameraman')
  await ctx.sh('bash mobile/apps/tsCameraman/scripts/bootstrap.sh')
  const { ipa, dsyms, build } = await archiveFieldApp(
    ctx,
    'mobile/apps/tsCameraman',
    'App/Cameraman.entitlements',
    'mobile/apps/tsCameraman/Cameraman.xcodeproj',
    'Cameraman',
    app
  )
  await ctx.artifacts.save('cameraman-ipa', ipa)
  await ctx.artifacts.save('cameraman-dsym', dsyms)
  await ctx.publish({
    app,
    platform: 'ios',
    path: ipa,
    version: FIELD_VERSION,
    buildNumber: build
  })
}

export async function compileCameraman(ctx: Stage): Promise<void> {
  const app = fieldAppId(CAMERAMAN_APP, CAMERAMAN_DEVELOP_APP, ctx.run.branch)
  const root = developRoot(ctx)
  if (app === CAMERAMAN_DEVELOP_APP)
    applyFieldDevelopIdentity(root, 'cameraman')
  const dir = 'mobile/apps/tsCameramanAndroid'
  writeFieldClientConfig(path.join(root, dir), app)
  const build = ctx.getBuildNumber(app)
  const host = new URL(fieldOrigin(ctx.run.branch)).host
  await ctx.sh(
    [
      'test -f app/debug.keystore || keytool -genkeypair',
      '-keystore app/debug.keystore -alias androiddebugkey',
      '-keyalg RSA -keysize 2048 -validity 10000',
      '-storepass android -keypass android',
      "-dname 'CN=Android Debug,O=Android,C=US'"
    ].join(' '),
    { cwd: dir }
  )
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
      cwd: dir,
      env: {
        MASON_BUILD_NUMBER: build,
        MASON_APP_VERSION: FIELD_VERSION,
        TS_PRIMARY_HOST: host
      }
    }
  )
  const apks = await ctx.fs.glob(`${CAMERAMAN_APK_DIR}/*.apk`)
  if (apks[0] == null) throw new Error('No Cameraman release APK was built')
  await ctx.stash('cameraman-release', `${CAMERAMAN_APK_DIR}/*.apk`)
}

/** Signs the compiled Cameraman APK with the release key and publishes it. */
export async function signCameraman(ctx: Stage): Promise<void> {
  const app = fieldAppId(CAMERAMAN_APP, CAMERAMAN_DEVELOP_APP, ctx.run.branch)
  await ctx.unstash('cameraman-release')
  await ctx.sh(
    `"$HOME/.local/bin/teamstation-sign-release-apk" ${CAMERAMAN_APK_DIR}`
  )
  const apks = await ctx.fs.glob(`${CAMERAMAN_APK_DIR}/*.apk`)
  const apk = apks[0]
  if (apk == null) throw new Error('No Cameraman release APK was signed')
  await ctx.artifacts.save('cameraman-apk', apk)
  await ctx.publish({
    app,
    platform: 'android',
    path: apk,
    version: FIELD_VERSION,
    buildNumber: ctx.getBuildNumber(app)
  })
}

/**
 * The Read Me in Distributor's disk image. Mason signs it with the team's
 * development identity and does not notarize it (the team has no Developer
 * ID certificate), so Gatekeeper stops the first launch until it is allowed.
 */
export function distributorReadMe(name: string, build: string): string {
  return `${name}, build ${build} (${name} > About ${name} shows it)

1. Drag ${name} onto Applications.

2. Open it from Applications. The first time, macOS says it cannot check the
   app, because it is not notarized. Click Done, open System Settings >
   Privacy & Security, find "${name} was blocked", and click Open Anyway.
   This is needed once. (Or, in Terminal:
   xattr -dr com.apple.quarantine "/Applications/${name}.app")
   It is signed for development, so it opens only on a Mac registered to
   the TeamStation team.

3. Plug the iPad in with a USB-C cable, tap Trust on the iPad if it asks, and
   open TS Director on it, in front.

Needs macOS 15 or later.
`
}

export async function archiveDistributor(ctx: Stage): Promise<void> {
  const app = fieldAppId(
    DISTRIBUTOR_APP,
    DISTRIBUTOR_DEVELOP_APP,
    ctx.run.branch
  )
  const name =
    app === DISTRIBUTOR_DEVELOP_APP
      ? DISTRIBUTOR_DEVELOP_NAME
      : DISTRIBUTOR_NAME
  const root = developRoot(ctx)
  if (app === DISTRIBUTOR_DEVELOP_APP)
    applyFieldDevelopIdentity(root, 'distributor')
  const dir = 'mobile/apps/tsDistributor'
  writeFieldClientConfig(path.join(root, dir), app)
  await ctx.sh(`node scripts/clientConfig.mjs ${dir}`)
  await ctx.sh('xcodegen generate --quiet', { cwd: dir })
  const build = ctx.getBuildNumber(app)
  const archived = await ctx.apple.archive({
    project: `${dir}/Distributor.xcodeproj`,
    scheme: 'Distributor',
    configuration: 'Release',
    destination: 'generic/platform=macOS',
    version: FIELD_VERSION,
    buildNumber: build,
    xcargs: fieldLinkSettings(dir, ctx.run.branch)
  })
  if (archived.app == null) throw new Error('No app was exported')
  // Laid out as scripts/package.sh lays it out: the app, an Applications link
  // to drag it onto, and a Read Me for the first launch.
  const image = 'distributor-image'
  const bundle = path.basename(archived.app)
  await ctx.sh(
    [
      `rm -rf ${image}`,
      `mkdir ${image}`,
      `ditto ${JSON.stringify(archived.app)} ${JSON.stringify(`${image}/${bundle}`)}`,
      `ln -s /Applications ${image}/Applications`
    ].join(' && ')
  )
  mkdirSync(path.join(root, image), { recursive: true })
  writeFileSync(
    path.join(root, image, 'Read Me.txt'),
    distributorReadMe(name, build)
  )
  const packed = 'distributor.dmg'
  await ctx.sh(
    `hdiutil create -volname ${JSON.stringify(name)} -srcfolder ${image} -ov -format UDZO ${packed}`
  )
  await ctx.artifacts.save('distributor-app', packed)
  await ctx.artifacts.save('distributor-dsym', archived.dsyms)
  await ctx.publish({
    app,
    platform: 'macos',
    path: packed,
    version: FIELD_VERSION,
    buildNumber: build
  })
}

export async function retrieveSoakArtifacts(ctx: Stage): Promise<void> {
      for (const [workflow, name] of [['tvos', 'tvos-ipa'], ['build', 'ios-ipa'], ['build', 'android-apk']]) {
        await ctx.artifacts.fetch({ workflow, name, commit: '5ed3a9f8118d9e96a5e0df78b22d35af46da1886', status: 'success' }, 'soak-artifacts/' + name)
      }
      await ctx.stash('soak-artifacts', 'soak-artifacts/**/*')
}
