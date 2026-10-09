import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { BuildValidationFailure, type ValidationCheck } from './failure'
import { appDirectory, buildEnvironment, prepare } from './prepare'
import { type BuildContext, type BuiltPackage, nativeNumber } from './runner'
import { sentryCliEnvironment, sentryRelease, sentryUploader } from './sentry'
import { noSymlinks } from './state'

/** Where React Native's Gradle plugin leaves the release bundle and its Hermes map. */
export const ANDROID_BUNDLE =
  'app/build/generated/assets/react/release/index.android.bundle'
export const ANDROID_SOURCE_MAP =
  'app/build/generated/sourcemaps/react/release/index.android.bundle.map'
/** Where a Kotlin app's release build leaves its native libraries with their symbols. */
export const ANDROID_NATIVE_LIBS =
  'app/build/intermediates/merged_native_libs/release'

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
export function verifyAndroidMetadata(
  badging: string,
  certificate: string,
  context: BuildContext
): void {
  const config = context.settings.apps[context.target.app].android?.android
  const match =
    /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m.exec(
      badging
    )
  // Some verifier versions decorate output or repeat the same signer across
  // signature schemes. Count unique signer/certificate pairs, not print lines.
  // Terminal decoration is not part of the verifier's certificate metadata.
  // eslint-disable-next-line no-control-regex
  const clean = certificate.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  const reports = [
    ...clean.matchAll(
      /^[ \t]*(?:Signer[ \t]+(?:#(\d+)|\(minSdkVersion=\d+(?: \(dev release=true\))?,[ \t]*maxSdkVersion=\d+\))|V2 Signer:)[ \t]+certificate[ \t]+SHA-256[ \t]+digest:[ \t]*([a-fA-F0-9]{64})[ \t]*$/gim
    )
  ]
  const signers = [...new Set(reports.map(report => report[2].toLowerCase()))]
  const numbered = new Set(
    reports.filter(report => report[1] != null).map(report => report[1])
  )
  const declared = /^[ \t]*Number of signers:[ \t]*(\d+)[ \t]*$/gim.exec(clean)
  const checks: ValidationCheck[] = []
  if (match?.[1] !== context.target.app) checks.push('bundle-id')
  if (match?.[2] !== String(context.buildNumber)) checks.push('build-number')
  if (match?.[3] !== context.version) checks.push('version')
  if (badging.includes('application-debuggable')) checks.push('debuggable')
  if (
    signers.length !== 1 ||
    numbered.size > 1 ||
    (declared != null && Number(declared[1]) !== 1)
  )
    checks.push('signer-count')
  if (
    config?.certificateSha256 == null ||
    signers[0] !== config.certificateSha256
  )
    checks.push('certificate')
  if (checks.length > 0)
    throw new BuildValidationFailure(
      'Android package identity, version or signing certificate did not match',
      checks
    )
}
export async function android(context: BuildContext): Promise<BuiltPackage> {
  context.reportStage?.('android.prepare')
  const config = context.settings.apps[context.target.app].android?.android
  const { tools } = context.settings
  if (config == null || tools.aapt == null || tools.apksigner == null)
    throw new Error('Android signing and verification tools are required')
  noSymlinks(config.keystore)
  if (
    !statSync(config.keystore).isFile() ||
    (statSync(config.keystore).mode & 0o077) !== 0
  )
    throw new Error('Android keystore must be a private regular file')
  const directory = appDirectory(context)
  const project =
    context.target.kind === 'react-native'
      ? path.join(directory, 'android')
      : directory
  if (!existsSync(path.join(project, 'gradlew')))
    throw new Error('Android project is missing')
  // The token file is read before the build, so a bad one fails in seconds.
  const sentry = context.settings.apps[context.target.app].sentry
  const upload =
    sentry == null
      ? undefined
      : sentryUploader(
          tools.sentryCli,
          sentryCliEnvironment(sentry),
          context.processes,
          project
        )
  await prepare(context)
  const init = path.join(directory, '.deploy', 'signing.gradle')
  writeFileSync(init, androidOverride, { mode: 0o600 })
  const env = {
    ...buildEnvironment(context),
    ...(context.target.app === 'app.teamstation.app'
      ? { GOOGLE_MAPS_ANDROID_API_KEY: process.env.GOOGLE_MAPS_ANDROID_API_KEY }
      : {}),
    GRADLE_USER_HOME: path.join(directory, '.deploy', 'gradle'),
    DEPLOY_BUILD_NUMBER: String(context.buildNumber),
    DEPLOY_VERSION: context.version,
    DEPLOY_KEYSTORE: config.keystore,
    DEPLOY_STORE_PASSWORD: config.storePassword,
    DEPLOY_KEY_PASSWORD: config.keyPassword,
    DEPLOY_KEY_ALIAS: config.alias
  }
  try {
    context.reportStage?.('android.compile')
    await context.processes.run({
      file: path.join(project, 'gradlew'),
      args: ['--no-daemon', '--init-script', init, ':app:assembleRelease'],
      cwd: project,
      env,
      capture: false
    })
    context.reportStage?.('android.verify')
    const outputs = path.join(project, 'app/build/outputs/apk/release')
    const names = readdirSync(outputs).filter(name => name.endsWith('.apk'))
    if (names.length !== 1)
      throw new Error('Expected one universal release APK')
    const file = path.join(outputs, names[0])
    noSymlinks(file)
    const badging = await context.processes.run({
      file: tools.aapt,
      args: ['dump', 'badging', file],
      cwd: project
    })
    const signature = await context.processes.run({
      file: tools.apksigner,
      args: ['verify', '--verbose', '--print-certs', file],
      cwd: project,
      captureStderr: true
    })
    verifyAndroidMetadata(badging, signature, context)
    if (context.target.kind === 'react-native') {
      const entries = await context.processes.run({
        file: 'unzip',
        args: ['-l', file],
        cwd: project
      })
      if (
        !/\s[1-9]\d*\s+[^\n]*assets\/index\.android\.bundle\s*$/m.test(entries)
      )
        throw new Error('Release APK has no bundled JavaScript')
      if (upload != null) {
        context.reportStage?.('sentry.source-map')
        await upload.bundle(
          path.join(project, ANDROID_BUNDLE),
          path.join(project, ANDROID_SOURCE_MAP),
          'index.android.bundle',
          sentryRelease(
            context.target.app,
            context.version,
            nativeNumber('android', context.buildNumber)
          ),
          directory
        )
      }
    }
    if (upload != null && context.target.kind === 'kotlin') {
      context.reportStage?.('sentry.native-libraries')
      await upload.nativeLibraries(path.join(project, ANDROID_NATIVE_LIBS))
    }
    return { file, buildNumber: nativeNumber('android', context.buildNumber) }
  } finally {
    rmSync(init, { force: true })
  }
}
