/**
 * The pipeline's stage functions. `Masonfile.ts` exports them; Mason runs
 * each on a worker with the stage's checkout as its workspace. Signing,
 * TestFlight and notarization are Mason's (`ctx.apple`), publishing is
 * `ctx.publish`, and the deployment's private settings are the project
 * secret `TS_PIPELINE_CONFIG` (see `config.ts`).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import path from 'node:path'

import type { Json, Stage } from '@mason/types'

import type { Row } from './apps.ts'
import { rowFor } from './apps.ts'
import type { PipelineConfig } from './config.ts'
import {
  buildEnvironment,
  pipelineConfig,
  sentryEnvironment,
  sentryRelease,
  serverOrigin
} from './config.ts'

/** Where a stage leaves what it builds, inside its workspace. */
export const OUTPUT = 'build/mason'
/** The test results the `test` stage writes. */
export const TEST_RESULTS = `${OUTPUT}/test-results.xml`

// A Gradle init script works with both the Groovy and Kotlin application projects.
// Configuration stays in the child environment, never in checked-in source.
export const androidOverride = `gradle.beforeProject { project ->
  project.tasks.configureEach { task ->
    if (task.name.matches('createBundle.*JsAndAssets')) {
      ['TS_BUILD_INFO', 'TS_API_BASE_URL', 'TS_PRIMARY_HOST'].each { key ->
        task.inputs.property(key, project.providers.environmentVariable(key).orElse(''))
      }
    }
  }
  project.plugins.withId('com.android.application') {
    project.extensions.getByName('androidComponents').finalizeDsl { android ->
      android.defaultConfig.versionCode = Integer.parseInt(System.getenv('DEPLOY_BUILD_NUMBER'))
      android.defaultConfig.versionName = System.getenv('DEPLOY_VERSION')
      def signing = android.signingConfigs.maybeCreate('deployment')
      signing.storeFile = new File(System.getenv('DEPLOY_KEYSTORE'))
      signing.storePassword = System.getenv('DEPLOY_STORE_PASSWORD')
      signing.keyAlias = System.getenv('DEPLOY_KEY_ALIAS')
      signing.keyPassword = System.getenv('DEPLOY_KEY_PASSWORD')
      android.buildTypes.getByName('release').signingConfig = signing
    }
  }
}
`

/** The release version every app shares: the root `package.json`'s `x.y.z`. */
export async function appVersion(ctx: Stage): Promise<string> {
  const version: unknown = JSON.parse(await ctx.fs.read('package.json')).version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('package.json version must be x.y.z')
  return version
}

/** What every app build starts from: its row, settings, version, number and environment. */
export interface Build {
  row: Row
  config: PipelineConfig
  version: string
  buildNumber: string
  origin: string | undefined
  env: Record<string, string>
}
export async function startBuild(ctx: Stage, row: Row): Promise<Build> {
  const config = pipelineConfig(ctx.secret('TS_PIPELINE_CONFIG'))
  const version = await appVersion(ctx)
  const buildNumber = ctx.getBuildNumber('app')
  const origin = serverOrigin(config, String(ctx.run.params.seat ?? 'none'))
  const env = buildEnvironment(
    {
      app: row.app,
      version,
      buildNumber,
      branch: ctx.run.branch,
      commit: ctx.run.commit,
      builtAt: new Date().toISOString()
    },
    origin,
    config
  )
  ctx.log.info(
    `${row.app} ${row.platform} ${version} (${buildNumber})${origin == null ? '' : ` for ${new URL(origin).host}`}`
  )
  return { row, config, version, buildNumber, origin, env }
}

/**
 * The app's `clientConfig.json`: its link host and the team that signs it,
 * which the Xcode and Gradle projects read. A build with neither has none.
 */
export async function writeClientConfig(
  ctx: Stage,
  build: Build,
  teamId?: string
): Promise<void> {
  const file = path.join(build.row.path, 'clientConfig.json')
  const out = {
    ...(build.config.appOrigin == null
      ? {}
      : { appOrigin: build.config.appOrigin }),
    ...(teamId == null ? {} : { appleTeamId: teamId })
  }
  if (Object.keys(out).length === 0) {
    rmSync(path.join(ctx.workspace, file), { force: true })
    return
  }
  await ctx.fs.write(file, JSON.stringify(out, null, 2) + '\n')
}

/** Dependencies and generated projects: npm for React Native and Sentry, XcodeGen for Swift apps. */
export async function prepareApp(ctx: Stage, build: Build): Promise<void> {
  const { row } = build
  if (
    row.kind === 'react-native' ||
    sentryEnvironment(build.config, row.app) != null
  )
    await ctx.exec('npm', ['ci'], { env: build.env })
  if (row.kind !== 'swift') return
  if (row.app === 'app.teamstation.director')
    await ctx.exec('bash', ['scripts/bootstrapNdi.sh'], {
      cwd: row.path,
      env: build.env
    })
  await ctx.exec('xcodegen', ['generate', '--quiet'], {
    cwd: row.path,
    env: build.env
  })
}

/** `clientConfig.xcconfig` for xcodebuild's -xcconfig, from `scripts/clientConfig.mjs`. */
export async function xcconfig(ctx: Stage, row: Row): Promise<string> {
  const printed = await ctx.exec('node', [
    'scripts/clientConfig.mjs',
    row.path,
    ...(row.entitlements == null ? [] : ['--entitlements', row.entitlements])
  ])
  return path.resolve(ctx.workspace, printed.stdout.trim())
}

/** Runs the deploy tool's Sentry upload for a build, when the app has a Sentry project. */
export async function sentryUpload(
  ctx: Stage,
  build: Build,
  args: string[]
): Promise<void> {
  const env = sentryEnvironment(build.config, build.row.app)
  if (env == null) return
  const { release, dist } = sentryRelease(
    build.row.app,
    build.version,
    build.buildNumber
  )
  await ctx.exec(
    'node',
    [
      '-r',
      'sucrase/register',
      'scripts/deploy/sentryUpload.ts',
      '--release',
      release,
      '--dist',
      dist,
      ...args
    ],
    {
      env: {
        ...env,
        SENTRY_CLI: path.join(ctx.workspace, 'node_modules/.bin/sentry-cli')
      }
    }
  )
}

/** The Xcode project or workspace of an Apple row. */
function xcodeProject(row: Row): { workspace: string } | { project: string } {
  if (row.scheme == null) throw new Error(`${row.name} has no scheme`)
  return row.workspace != null
    ? { workspace: row.workspace }
    : { project: path.join(row.path, `${row.scheme}.xcodeproj`) }
}

/** The one `.app` under a directory. */
function appIn(directory: string): string {
  const apps = readdirSync(directory).filter(name => name.endsWith('.app'))
  if (apps.length !== 1)
    throw new Error(`Expected one app in ${path.basename(directory)}`)
  return path.join(directory, apps[0])
}

/** Archives and exports an Apple app with the stage's signing, and sends its symbols to Sentry. */
async function archiveApple(
  ctx: Stage,
  build: Build,
  xcargs: string[]
): Promise<{ archive: string; ipa?: string; app?: string; dsyms: string }> {
  const { row } = build
  await prepareApp(ctx, build)
  await writeClientConfig(ctx, build, ctx.apple.signing.teamId)
  const config = await xcconfig(ctx, row)
  if (row.kind === 'react-native')
    await ctx.exec('pod', ['install', '--deployment'], {
      cwd: path.join(row.path, 'ios'),
      env: build.env
    })
  const output = `${OUTPUT}/${row.name}`
  const sourceMap =
    row.kind === 'react-native' &&
    sentryEnvironment(build.config, row.app) != null
      ? path.join(ctx.workspace, output, 'main.jsbundle.map')
      : undefined
  const built = await ctx.apple.archive({
    ...xcodeProject(row),
    scheme: row.scheme!,
    version: build.version,
    buildNumber: build.buildNumber,
    output,
    env: build.env,
    xcargs: [
      '-xcconfig',
      config,
      'ONLY_ACTIVE_ARCH=NO',
      'OTHER_SWIFT_FLAGS=$(inherited) -disable-cmo',
      ...xcargs,
      ...(sourceMap == null ? [] : [`SOURCEMAP_FILE=${sourceMap}`])
    ]
  })
  await ctx.artifacts.save(`${row.name}-dsyms`, built.dsyms)
  await sentryUpload(ctx, build, ['--dsyms', path.join(built.archive, 'dSYMs')])
  if (sourceMap != null) {
    const app = appIn(path.join(built.archive, 'Products/Applications'))
    await sentryUpload(ctx, build, [
      '--bundle',
      path.join(app, 'main.jsbundle'),
      '--map',
      sourceMap,
      '--name',
      'main.jsbundle',
      '--root',
      ctx.workspace
    ])
  }
  return built
}

/** Checks an iOS app's `UIDeviceFamily`: iPhone apps hold 1, iPad apps 2. */
async function checkDeviceFamily(
  ctx: Stage,
  row: Row,
  archive: string
): Promise<void> {
  if (row.deviceFamily == null) return
  const app = appIn(path.join(archive, 'Products/Applications'))
  const families = await ctx.exec('plutil', [
    '-extract',
    'UIDeviceFamily',
    'json',
    '-o',
    '-',
    path.join(app, 'Info.plist')
  ])
  const list: unknown = JSON.parse(families.stdout)
  if (!Array.isArray(list) || !list.includes(row.deviceFamily))
    throw new Error(
      `${row.name} must support device family ${row.deviceFamily}, not ${families.stdout.trim()}`
    )
}

/** A Simulator build of the same commit, saved as an artifact for Simulator tests. */
export async function simulatorBuild(ctx: Stage, build: Build): Promise<void> {
  const { row } = build
  const derived = path.join(OUTPUT, row.name, 'simulator')
  const project = xcodeProject(row)
  await ctx.exec(
    'xcodebuild',
    [
      'build',
      ...('workspace' in project
        ? ['-workspace', project.workspace]
        : ['-project', project.project]),
      '-scheme',
      row.scheme!,
      '-configuration',
      'Release',
      '-sdk',
      'iphonesimulator',
      '-destination',
      'generic/platform=iOS Simulator',
      '-derivedDataPath',
      derived,
      '-xcconfig',
      await xcconfig(ctx, row),
      'CODE_SIGNING_ALLOWED=NO',
      // Release bundles the JavaScript; Swift's optimizer crashes compiling
      // CameramanControlUI for the Simulator, and Apple silicon Simulators
      // run arm64 only.
      'ARCHS=arm64',
      'SWIFT_OPTIMIZATION_LEVEL=-Onone',
      `MARKETING_VERSION=${build.version}`,
      `CURRENT_PROJECT_VERSION=${build.buildNumber}`
    ],
    { env: build.env, quiet: true }
  )
  const app = appIn(
    path.join(ctx.workspace, derived, 'Build/Products/Release-iphonesimulator')
  )
  const zip = path.join(ctx.workspace, OUTPUT, `${row.name}-simulator.zip`)
  await ctx.exec('ditto', ['-c', '-k', '--keepParent', app, zip])
  await ctx.artifacts.save(
    `${row.name}-simulator`,
    path.relative(ctx.workspace, zip)
  )
}

/**
 * The suites that run in Node: the shared and server code and this pipeline.
 * The app's own tests import React Native and run on devices instead.
 */
export const UNIT_TESTS = [
  'src/common/**/*.test.ts',
  'src/server/**/*.test.ts',
  'scripts/pipeline/**/*.test.ts'
]

/** Lint and unit tests; failures mark the run unstable, so the apps still build. */
export async function test(ctx: Stage): Promise<Json> {
  await ctx.exec('npm', ['ci'])
  // ESLint over the whole repository needs more than Node's default heap.
  const lint = await ctx.exec('npm', ['run', 'lint'], {
    allowFailure: true,
    env: { NODE_OPTIONS: '--max-old-space-size=8192' }
  })
  if (lint.code !== 0) ctx.unstable('Lint failed')
  mkdirSync(path.join(ctx.workspace, OUTPUT), { recursive: true })
  await ctx.exec(
    'npx',
    [
      'mocha',
      '-r',
      'sucrase/register',
      '-r',
      './src/test/scoringDomSetup.cjs',
      '--extension',
      'ts',
      ...UNIT_TESTS.flatMap(spec => ['--spec', spec]),
      '--ignore',
      '**/node_modules/**',
      '--exit',
      '--reporter',
      'xunit',
      '--reporter-option',
      `output=${TEST_RESULTS}`
    ],
    { allowFailure: true }
  )
  if (!existsSync(path.join(ctx.workspace, TEST_RESULTS))) {
    ctx.unstable('The unit tests did not run')
    return { lint: lint.code === 0, ran: false }
  }
  // Mocha's `xunit` reporter writes JUnit's <testsuite> format.
  const summary = await ctx.tests('junit', TEST_RESULTS, { failOn: 'unstable' })
  return { lint: lint.code === 0, ...summary }
}

/** An ad hoc iOS build: archived and signed by Mason, published, with a Simulator build. */
export async function ios(ctx: Stage): Promise<Json> {
  const build = await startBuild(ctx, rowFor(ctx.stage.name))
  const built = await archiveApple(ctx, build, ['ARCHS=arm64'])
  await checkDeviceFamily(ctx, build.row, built.archive)
  if (built.ipa == null) throw new Error('The export made no IPA')
  const published = await ctx.publish({
    app: build.row.app,
    platform: 'ios',
    path: path.relative(ctx.workspace, built.ipa),
    buildNumber: build.buildNumber,
    metadata: { server: build.origin ?? null }
  })
  await simulatorBuild(ctx, build)
  return { ...published, buildNumber: build.buildNumber }
}

/** The Distributor for macOS: Developer ID signed, notarized and stapled, in a signed DMG. */
export async function macos(ctx: Stage): Promise<Json> {
  const build = await startBuild(ctx, rowFor(ctx.stage.name))
  const { row } = build
  const built = await archiveApple(ctx, build, [
    'ARCHS=arm64 x86_64',
    'ENABLE_HARDENED_RUNTIME=YES'
  ])
  if (built.app == null) throw new Error('The export made no app')
  const out = path.join(ctx.workspace, OUTPUT, row.name)
  // The app is notarized and stapled on its own, so it opens offline once copied out of the image.
  const zip = path.join(out, `${row.scheme}.zip`)
  await ctx.exec('ditto', ['-c', '-k', '--keepParent', built.app, zip])
  await ctx.apple.notarize({
    path: path.relative(ctx.workspace, zip),
    staple: false
  })
  await ctx.exec('xcrun', ['stapler', 'staple', built.app])
  const staging = path.join(out, 'dmg')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  await ctx.exec('ditto', [
    built.app,
    path.join(staging, path.basename(built.app))
  ])
  symlinkSync('/Applications', path.join(staging, 'Applications'))
  const dmg = path.join(out, `${row.scheme}.dmg`)
  rmSync(dmg, { force: true })
  await ctx.exec('hdiutil', [
    'create',
    '-volname',
    row.scheme!,
    '-srcfolder',
    staging,
    '-format',
    'UDZO',
    dmg
  ])
  const { identity, keychain } = ctx.apple.signing
  await ctx.exec('codesign', [
    '--sign',
    identity,
    '--keychain',
    keychain,
    '--timestamp',
    dmg
  ])
  await ctx.apple.notarize({
    path: path.relative(ctx.workspace, dmg),
    staple: true
  })
  await ctx.exec('spctl', ['-a', '-vv', '-t', 'install', dmg])
  const published = await ctx.publish({
    app: row.app,
    platform: 'macos',
    path: path.relative(ctx.workspace, dmg),
    version: build.version,
    buildNumber: build.buildNumber,
    metadata: { server: build.origin ?? null }
  })
  return { ...published, buildNumber: build.buildNumber }
}

/** The Android signing settings, the `ANDROID_SIGNING` secret: alias, passwords and the certificate's SHA-256. */
export function androidSigning(text: string): {
  alias: string
  storePassword: string
  keyPassword: string
  certificateSha256: string
} {
  const value: unknown = JSON.parse(text)
  if (value == null || typeof value !== 'object')
    throw new Error('ANDROID_SIGNING must be an object')
  const { alias, storePassword, keyPassword, certificateSha256 } =
    value as Record<string, unknown>
  if (
    typeof alias !== 'string' ||
    typeof storePassword !== 'string' ||
    typeof keyPassword !== 'string' ||
    typeof certificateSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(certificateSha256)
  )
    throw new Error(
      'ANDROID_SIGNING needs alias, storePassword, keyPassword and certificateSha256 (64 lowercase hex)'
    )
  return { alias, storePassword, keyPassword, certificateSha256 }
}

/** The single signer's SHA-256 from `apksigner verify --print-certs`. */
export function apkSigner(output: string): string {
  const digests = [
    ...output.matchAll(
      /^(?:Signer #\d+|V\d Signer):? certificate SHA-256 digest: ([a-fA-F0-9]{64})$/gm
    )
  ].map(match => match[1].toLowerCase())
  const signers = /^Number of signers: (\d+)$/m.exec(output)
  if (new Set(digests).size !== 1 || (signers != null && signers[1] !== '1'))
    throw new Error('The APK must have exactly one signer')
  return digests[0]
}

/** An Android release build, signed with the project's keystore, checked and published. */
export async function android(ctx: Stage): Promise<Json> {
  const build = await startBuild(ctx, rowFor(ctx.stage.name))
  const { row } = build
  const signing = androidSigning(ctx.secret('ANDROID_SIGNING'))
  await prepareApp(ctx, build)
  await writeClientConfig(ctx, build)
  const project =
    row.kind === 'react-native' ? path.join(row.path, 'android') : row.path
  const init = path.join(OUTPUT, row.name, 'signing.gradle')
  await ctx.fs.write(init, androidOverride)
  await ctx.exec(
    './gradlew',
    [
      '--no-daemon',
      '--init-script',
      path.join(ctx.workspace, init),
      ':app:assembleRelease'
    ],
    {
      cwd: project,
      env: {
        ...build.env,
        DEPLOY_BUILD_NUMBER: build.buildNumber,
        DEPLOY_VERSION: build.version,
        DEPLOY_KEYSTORE: ctx.secretFile('ANDROID_KEYSTORE'),
        DEPLOY_STORE_PASSWORD: signing.storePassword,
        DEPLOY_KEY_ALIAS: signing.alias,
        DEPLOY_KEY_PASSWORD: signing.keyPassword,
        ...(row.app === 'app.teamstation.app' &&
        build.config.googleMapsAndroidKey != null
          ? { GOOGLE_MAPS_ANDROID_API_KEY: build.config.googleMapsAndroidKey }
          : {})
      }
    }
  )
  const outputs = path.join(ctx.workspace, project, 'app/build/outputs')
  const apks = readdirSync(path.join(outputs, 'apk/release')).filter(name =>
    name.endsWith('.apk')
  )
  if (apks.length !== 1) throw new Error('Expected one release APK')
  const apk = path.join(outputs, 'apk/release', apks[0])
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
  if (sdk == null) throw new Error('ANDROID_HOME is not set')
  const tools = path.join(sdk, 'build-tools')
  const latest = readdirSync(tools).sort().pop()
  if (latest == null) throw new Error('No Android build tools are installed')
  const verified = await ctx.exec(
    path.join(tools, latest, 'apksigner'),
    ['verify', '--print-certs', apk],
    { quiet: true }
  )
  if (apkSigner(verified.stdout) !== signing.certificateSha256)
    throw new Error('The APK is not signed with the configured certificate')
  const mapping = path.join(outputs, 'mapping/release/mapping.txt')
  if (existsSync(mapping))
    await ctx.artifacts.save(
      `${row.name}-mapping`,
      path.relative(ctx.workspace, mapping)
    )
  if (row.kind === 'react-native')
    await sentryUpload(ctx, build, [
      '--bundle',
      path.join(
        ctx.workspace,
        project,
        'app/build/generated/assets/react/release/index.android.bundle'
      ),
      '--map',
      path.join(
        ctx.workspace,
        project,
        'app/build/generated/sourcemaps/react/release/index.android.bundle.map'
      ),
      '--name',
      'index.android.bundle',
      '--root',
      ctx.workspace
    ])
  else
    await sentryUpload(ctx, build, [
      '--native-libs',
      path.join(
        ctx.workspace,
        project,
        'app/build/intermediates/merged_native_libs/release'
      )
    ])
  const published = await ctx.publish({
    app: row.app,
    platform: 'android',
    path: path.relative(ctx.workspace, apk),
    buildNumber: build.buildNumber,
    metadata: { server: build.origin ?? null }
  })
  return { ...published, buildNumber: build.buildNumber }
}

/** The release: TeamStation's App Store build, sent to TestFlight's groups once approved. */
export async function appStore(ctx: Stage): Promise<Json> {
  const build = await startBuild(ctx, rowFor('teamstation-ios'))
  const built = await archiveApple(ctx, build, ['ARCHS=arm64'])
  if (built.ipa == null) throw new Error('The export made no IPA')
  const groups = String(ctx.run.params.groups ?? '')
    .split(',')
    .map(group => group.trim())
    .filter(group => group !== '')
  const sent = await ctx.apple.testflight({
    path: path.relative(ctx.workspace, built.ipa),
    groups,
    whatToTest: `${ctx.run.branch} ${ctx.run.commit.slice(0, 7)}`,
    usesNonExemptEncryption: false
  })
  return { ...sent, groups }
}
