import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  android,
  ANDROID_BUNDLE,
  ANDROID_NATIVE_LIBS,
  ANDROID_SOURCE_MAP,
  androidOverride,
  verifyAndroidMetadata
} from './android'
import {
  archive,
  bundleEnvironment,
  ios,
  type Profile,
  readInfo,
  ruby,
  type Signing,
  validateProfile,
  verifyApp,
  withSigning,
  xml
} from './apple'
import { resolveSettings } from './config'
import { app, fixtureSettings, testRoot } from './config.test'
import { appDirectory, buildEnvironment, prepare } from './prepare'
import { type Command, Processes } from './process'
import type { BuildContext } from './runner'
import { target } from './targets'

let root: string, context: BuildContext, calls: Command[], profile: Profile
let certificate: Buffer
let original: Processes['run'], dispatch: (command: Command) => Promise<string>
const team = 'EXAMPLETEAM'
function info(): object {
  return {
    CFBundleIdentifier: context.target.app,
    CFBundleVersion: '26093004',
    CFBundleShortVersionString: '1.2.3',
    CFBundleExecutable: 'Example',
    UIDeviceFamily: [1, 2]
  }
}
function file(name: string, content = 'fixture'): string {
  mkdirSync(path.dirname(name), { recursive: true })
  writeFileSync(name, content, { mode: 0o600 })
  return name
}
function request(command: Command): Record<string, any> {
  return JSON.parse(readFileSync(command.args.at(-1)!, 'utf8'))
}
function appTree(directory: string): string {
  file(path.join(directory, 'Info.plist'))
  file(path.join(directory, 'main.jsbundle'))
  return directory
}
let keychains: string[], defaultKeychain: string
async function fake(command: Command): Promise<string> {
  const [verb] = command.args
  if (command.file === 'security') {
    if (verb === 'list-keychains') {
      if (command.args.includes('-s')) keychains = command.args.slice(4)
      return keychains.map(p => JSON.stringify(p)).join('\n')
    }
    if (verb === 'default-keychain') {
      if (command.args.includes('-s')) defaultKeychain = command.args.at(-1)!
      return JSON.stringify(defaultKeychain)
    }
    return '<plist/>'
  }
  if (command.file === 'bundle' && command.args[1] === 'ruby') {
    const value = request(command)
    if (command.args[3] === 'project')
      file(
        path.join(value.project, 'project.pbxproj'),
        'temporary signing overrides'
      )
    if (command.args[3] === 'match')
      file(path.join(value.profilesDirectory, 'fixture.mobileprovision'))
    if (command.args[3] === 'profile') return JSON.stringify(profile)
    return ''
  }
  if (command.file === 'plutil')
    return JSON.stringify(
      command.args.at(-1)!.endsWith('entitlements.plist')
        ? profile.entitlements
        : info()
    )
  if (command.args[0]?.endsWith('clientConfig.mjs'))
    return path.join(command.args[1], 'clientConfig.xcconfig') + '\n'
  if (command.file === 'xcrun') return 'arm64'
  if (
    command.file === 'codesign' &&
    command.args.some(arg => arg.startsWith('--extract-certificates='))
  )
    writeFileSync(
      command.args
        .find(arg => arg.startsWith('--extract-certificates='))!
        .slice('--extract-certificates='.length) + '0',
      certificate
    )
  if (command.file === 'xcodebuild' && verb === 'archive') {
    const archivePath = command.args[command.args.indexOf('-archivePath') + 1]
    mkdirSync(path.join(archivePath, 'dSYMs'), { recursive: true })
    appTree(path.join(archivePath, 'Products/Applications/TeamStation.app'))
    const map = command.args.find(arg => arg.startsWith('SOURCEMAP_FILE='))
    if (map != null) file(map.slice('SOURCEMAP_FILE='.length), '{}')
  }
  if (command.file.endsWith('gradlew')) {
    file(path.join(command.cwd, ANDROID_BUNDLE))
    file(path.join(command.cwd, ANDROID_SOURCE_MAP), '{}')
  }
  if (command.file === 'xcodebuild' && verb === '-help')
    return 'method: release-testing'
  if (command.file === 'xcodebuild' && verb === '-exportArchive')
    file(path.join(command.args[4], 'fixture.ipa'))
  if (command.file === 'ditto')
    appTree(path.join(command.args.at(-1)!, 'Payload/Example.app'))
  if (command.file.endsWith('gradlew'))
    file(
      path.join(command.cwd, 'app/build/outputs/apk/release/app-release.apk')
    )
  if (command.file === 'aapt')
    return `package: name='${context.target.app}' versionCode='26093004' versionName='1.2.3'`
  if (command.file === 'apksigner')
    return `Signer #1 certificate SHA-256 digest: ${'a'.repeat(64)}`
  if (command.file === 'unzip')
    return '    800  2026-01-01 12:00 assets/index.android.bundle'
  return ''
}
function source(): void {
  file(path.join(context.source, 'package-lock.json'), '{}')
  file(path.join(context.source, 'ios/Podfile.lock'))
  file(
    path.join(context.source, 'ios/TeamStation.xcodeproj/project.pbxproj'),
    'user project bytes'
  )
  file(path.join(context.source, 'android/gradlew'))
}
describe('Native build and signing adapters', () => {
  beforeEach(() => {
    root = testRoot('adapters-')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=Apple Distribution: Fixture/OU=EXAMPLETEAM',
        '-keyout',
        path.join(root, 'certificate.key'),
        '-out',
        path.join(root, 'certificate.pem')
      ],
      { stdio: 'ignore' }
    )
    certificate = new X509Certificate(
      readFileSync(path.join(root, 'certificate.pem'))
    ).raw
    const settings = resolveSettings(
      {
        schemaVersion: 1,
        branches: { master: { settings: fixtureSettings(root) } }
      },
      'master'
    )
    settings.tools.node = process.execPath
    settings.tools.apksigner = 'apksigner'
    settings.tools.aapt = 'aapt'
    settings.apps[app].apiOrigin = 'https://app.example.test'
    settings.apps[app].android!.android!.keystore = file(
      path.join(root, 'key.keystore')
    )
    context = {
      source: path.join(root, 'source'),
      output: path.join(root, 'output'),
      settings,
      target: target(app, 'ios'),
      branch: 'master',
      commit: 'a'.repeat(40),
      version: '1.2.3',
      buildNumber: 26093004,
      buildTime: '2026-01-01T00:00:00Z',
      processes: new Processes(new AbortController().signal)
    }
    mkdirSync(context.source)
    mkdirSync(context.output)
    file(
      path.join(
        context.source,
        'ios',
        context.target.scheme! + '.xcodeproj/project.pbxproj'
      ),
      'user project bytes'
    )
    source()
    profile = {
      uuid: '00000000-0000-4000-8000-000000000001',
      name: 'Fixture',
      expires: '2099-01-01T00:00:00Z',
      teams: [team],
      devices: ['fixture-device'],
      platforms: ['iOS'],
      certificates: [createHash('sha256').update(certificate).digest('hex')],
      entitlements: {
        'application-identifier': `${team}.${app}`,
        'get-task-allow': false,
        'com.apple.developer.team-identifier': team
      }
    }
    keychains = [path.join(root, 'original.keychain')]
    defaultKeychain = keychains[0]
    calls = []
    // Preserve the prototype method for restoration, never call it unbound.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    original = Processes.prototype.run
    dispatch = fake
    Processes.prototype.run = async function (command) {
      calls.push(command)
      return await dispatch(command)
    }
  })
  afterEach(() => {
    Processes.prototype.run = original
    rmSync(root, { recursive: true, force: true })
  })
  it('prepares locked, isolated RN, harvester, Swift and NDI targets with public metadata only', async () => {
    assert.equal(
      JSON.parse(buildEnvironment(context).TS_BUILD_INFO!).commit,
      context.commit
    )
    assert.equal(buildEnvironment(context).TS_PRIMARY_HOST, 'app.example.test')
    assert.equal(
      buildEnvironment(context).TS_API_BASE_URL,
      'https://app.example.test/api/v1'
    )
    context.settings.apps[app].apiOrigin = 'https://api.example.test:8443'
    assert.equal(
      buildEnvironment(context).TS_PRIMARY_HOST,
      'api.example.test:8443'
    )
    assert.equal(
      buildEnvironment(context).TS_API_BASE_URL,
      'https://api.example.test:8443/api/v1'
    )
    assert.equal(await prepare(context), context.source)
    mkdirSync(path.join(context.source, 'node_modules'))
    await prepare(context)
    assert.equal(calls.filter(c => c.file === 'socket').length, 1)
    file(path.join(context.source, 'package-lock.json'), '{"changed":true}')
    await prepare(context)
    assert.equal(calls.filter(c => c.file === 'socket').length, 2)
    context.target = { ...context.target, harvester: true }
    await prepare(context)
    assert(calls.some(c => c.args.includes('build.harvester')))
    const watcher = target('app.teamstation.watcher', 'android')
    const packages = path.join(context.source, 'watcher')
    context.target = watcher
    context.settings.apps[watcher.app] = context.settings.apps[app]
    mkdirSync(path.join(context.source, watcher.path), { recursive: true })
    await assert.rejects(prepare(context), /locked/)
    file(path.join(packages, 'package-lock.json'), '{}')
    await prepare(context)
    assert.equal(calls.at(-1)?.cwd, packages)
    assert(existsSync(path.join(packages, '.deploy-dependencies')))
    assert(
      !existsSync(
        path.join(context.source, watcher.path, '.deploy-dependencies')
      )
    )
    context.target = target(app, 'ios')
    delete context.settings.apps[app].apiOrigin
    assert.equal(buildEnvironment(context).TS_API_BASE_URL, undefined)
    for (const id of [
      'app.teamstation.director',
      'app.teamstation.cameraman',
      'app.teamstation.preview'
    ]) {
      context.target = target(id, 'ios')
      mkdirSync(path.join(context.source, context.target.path), {
        recursive: true
      })
      context.settings.apps[id] = context.settings.apps[app]
      await prepare(context)
    }
    assert(calls.some(c => c.args.includes('scripts/bootstrapNdi.sh')))
    context.target = target(app, 'ios')
    rmSync(path.join(context.source, 'package-lock.json'))
    await assert.rejects(prepare(context), /locked/)
    context.target.path = 'missing'
    assert.throws(() => appDirectory(context))
  })
  it('uploads symbols to Sentry for an app with a sentry block, and only then', async () => {
    const sentry = {
      origin: 'https://sentry.example.test',
      org: 'teamstation',
      project: 'teamstation-app',
      dsn: 'https://0123456789abcdef0123456789abcdef@sentry.example.test/2',
      tokenFile: file(
        path.join(root, 'sentry-token.json'),
        JSON.stringify({
          schemaVersion: 1,
          origin: 'https://sentry.example.test',
          token: 'sntrys_fixture'
        })
      )
    }
    const uploads = (): Command[] =>
      calls.filter(c => path.basename(c.file) === 'sentry-cli')
    const signing: Signing = {
      keychain: 'k',
      directory: root,
      profiles: new Map()
    }
    await archive(context, signing)
    assert.equal(uploads().length, 0)
    assert(!calls.some(c => c.args.some(a => a.startsWith('SOURCEMAP_FILE='))))
    assert.equal(buildEnvironment(context).TS_SENTRY_DSN, undefined)

    context.settings.apps[app].sentry = sentry
    assert.equal(buildEnvironment(context).TS_SENTRY_DSN, sentry.dsn)
    calls = []
    await archive(context, signing)
    assert(calls.some(c => c.args.some(a => a.startsWith('SOURCEMAP_FILE='))))
    const [dsyms, maps] = uploads()
    assert.deepEqual(dsyms.args.slice(0, 3), [
      'debug-files',
      'upload',
      '--include-sources'
    ])
    assert.equal(dsyms.env?.SENTRY_AUTH_TOKEN, 'sntrys_fixture')
    assert.equal(dsyms.env?.SENTRY_PROJECT, 'teamstation-app')
    assert.deepEqual(maps.args.slice(0, 6), [
      'sourcemaps',
      'upload',
      '--release',
      `${app}@1.2.3+26093004`,
      '--dist',
      '26093004'
    ])

    calls = []
    context.target = target(app, 'android')
    await android(context)
    assert.deepEqual(uploads()[0].args.slice(2, 6), [
      '--release',
      `${app}@1.2.3+26093004`,
      '--dist',
      '26093004'
    ])

    calls = []
    context.target = target('app.teamstation.cameraman', 'android')
    mkdirSync(path.join(context.source, context.target.path), {
      recursive: true
    })
    file(path.join(context.source, context.target.path, 'gradlew'))
    context.settings.apps['app.teamstation.cameraman'] =
      context.settings.apps[app]
    mkdirSync(
      path.join(context.source, context.target.path, ANDROID_NATIVE_LIBS),
      { recursive: true }
    )
    await android(context)
    // A Kotlin app has no JavaScript bundle; its native libraries go up instead.
    assert.equal(uploads().length, 1)
    assert.deepEqual(uploads()[0].args.slice(0, 2), ['debug-files', 'upload'])
    assert(uploads()[0].args[2].endsWith(ANDROID_NATIVE_LIBS))

    // A missing token file stops the deploy before anything is built.
    rmSync(sentry.tokenFile)
    calls = []
    await assert.rejects(android(context))
    assert.equal(calls.length, 0)
    context.target = target(app, 'ios')
    await assert.rejects(archive(context, signing))
    assert.equal(calls.length, 0)
  })
  it('builds Groovy and Kotlin APKs using private signing and checks the finished identity', async () => {
    context.target = target(app, 'android')
    const beforeMapsKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY
    process.env.GOOGLE_MAPS_ANDROID_API_KEY = 'example-android-display-key'
    try {
      await android(context)
      assert.equal(
        calls.find(c => c.args.includes(':app:assembleRelease'))?.env
          ?.GOOGLE_MAPS_ANDROID_API_KEY,
        'example-android-display-key'
      )
    } finally {
      if (beforeMapsKey === undefined)
        delete process.env.GOOGLE_MAPS_ANDROID_API_KEY
      else process.env.GOOGLE_MAPS_ANDROID_API_KEY = beforeMapsKey
    }
    calls = []
    const result = await android(context)
    assert(result.file.endsWith('.apk'))
    assert.equal(result.buildNumber, '26093004')
    assert(calls.some(c => c.args.includes('--no-daemon')))
    assert(
      androidOverride.includes(
        "'TS_BUILD_INFO', 'TS_API_BASE_URL', 'TS_PRIMARY_HOST'"
      )
    )
    assert(androidOverride.includes('task.inputs.property'))
    assert(!existsSync(path.join(context.source, '.deploy/signing.gradle')))
    const id = 'app.teamstation.cameraman'
    context.settings.apps[id] = context.settings.apps[app]
    context.target = target(id, 'android')
    file(path.join(context.source, context.target.path, 'gradlew'))
    await android(context)
    const validBadging = `package: name='${id}' versionCode='26093004' versionName='1.2.3'`
    const v2Certificate = `Number of signers: 1\nV2 Signer: certificate SHA-256 digest: ${'a'.repeat(64)}`
    verifyAndroidMetadata(validBadging, v2Certificate, context)
    assert.throws(() => {
      verifyAndroidMetadata(
        validBadging,
        v2Certificate.replace('Number of signers: 1', 'Number of signers: 2'),
        context
      )
    })
    assert.throws(() => {
      verifyAndroidMetadata(
        validBadging,
        v2Certificate.replace('certificate SHA-256', 'public key SHA-256'),
        context
      )
    })
    for (const [badging, cert] of [
      [
        `package: name='${id}' versionCode='41' versionName='1.2.3'`,
        `Signer #1 certificate SHA-256 digest: ${'a'.repeat(64)}`
      ],
      [
        `package: name='${id}' versionCode='26093004' versionName='1.2.3'`,
        `Signer #1 certificate SHA-256 digest: ${'b'.repeat(64)}`
      ],
      ['bad', 'bad']
    ])
      assert.throws(() => {
        verifyAndroidMetadata(badging, cert, context)
      })
    chmodSync(context.settings.apps[app].android!.android!.keystore, 0o644)
    await assert.rejects(android(context), /private/)
    chmodSync(context.settings.apps[app].android!.android!.keystore, 0o600)
    context.settings.tools.aapt = undefined
    await assert.rejects(android(context), /tools/)
  })
  it('rejects missing projects, ambiguous APKs, absent JS and failed compilers while removing overrides', async () => {
    context.target = target(app, 'android')
    rmSync(path.join(context.source, 'android/gradlew'))
    await assert.rejects(android(context), /project/)
    source()
    dispatch = async c => (c.file === 'unzip' ? '' : await fake(c))
    await assert.rejects(android(context), /JavaScript/)
    file(
      path.join(
        context.source,
        'android/app/build/outputs/apk/release/other.apk'
      )
    )
    await assert.rejects(android(context), /one universal/)
    dispatch = async () => {
      throw new Error('Compiler failure')
    }
    await assert.rejects(android(context))
    assert(!existsSync(path.join(context.source, '.deploy/signing.gradle')))
  })
  it('checks profile identity, expiry, device eligibility and safe plist values', () => {
    assert.equal(validateProfile(profile, app, context).name, 'Fixture')
    for (const override of [
      { uuid: 'bad' },
      { expires: 'bad' },
      { expires: '2020-01-01' },
      { teams: [] },
      { devices: [] },
      { name: 'Other' },
      { platforms: ['OSX'] },
      { entitlements: { ...profile.entitlements, 'get-task-allow': true } }
    ])
      assert.throws(() =>
        validateProfile({ ...profile, ...override }, app, context)
      )
    context.settings.apps[app].ios!.apple!.requiredDevices = ['unregistered']
    assert.throws(() => validateProfile(profile, app, context))
    assert(xml({ 'a<&"': ['<&"', true, false] }).includes('&amp;'))
    assert.throws(() => xml(42))
    assert.throws(() => xml(null))
  })
  it('retrieves read-only Match assets, preserves existing profiles and cleans keychains on failure or cancellation', async () => {
    const home = path.join(root, 'home')
    await withSigning(
      context,
      async signing => {
        assert(signing.profiles.has(app))
        assert.equal(keychains.length, 2)
        keychains.push(path.join(root, 'other-agent.keychain'))
        defaultKeychain = signing.keychain
        return 0
      },
      home
    )
    assert.equal(keychains.length, 2)
    assert.equal(defaultKeychain, path.join(root, 'original.keychain'))
    assert.equal(readdirSync(context.output).length, 0)
    assert.equal(
      readdirSync(path.join(home, 'Library/MobileDevice/Provisioning Profiles'))
        .length,
      0
    )
    const existing = file(
      path.join(
        home,
        'Library/MobileDevice/Provisioning Profiles',
        profile.uuid + '.mobileprovision'
      )
    )
    await assert.rejects(
      withSigning(
        context,
        async () => {
          throw new Error('cancelled')
        },
        home
      ),
      /cancelled/
    )
    assert(existsSync(existing))
    assert.equal(readdirSync(context.output).length, 0)
    writeFileSync(existing, 'different')
    await assert.rejects(
      withSigning(context, async () => 0, home),
      /preserving/
    )
    context.settings.match!.branch = 'master'
    await assert.rejects(
      withSigning(context, async () => 0, home),
      /Separate/
    )
  })
  it('preserves the legacy Xcode alias while installing and cleaning only the modern profile', async () => {
    const home = path.join(root, 'home')
    const legacy = path.join(home, 'Library/MobileDevice/Provisioning Profiles')
    const modern = path.join(
      home,
      'Library/Developer/Xcode/UserData/Provisioning Profiles'
    )
    mkdirSync(path.dirname(legacy), { recursive: true })
    mkdirSync(modern, { recursive: true })
    const alias = path.relative(path.dirname(legacy), modern)
    symlinkSync(alias, legacy)
    const destination = path.join(modern, profile.uuid + '.mobileprovision')
    await withSigning(
      context,
      async () => {
        assert.equal(readFileSync(destination, 'utf8'), 'fixture')
        assert.equal(readlinkSync(legacy), alias)
      },
      home
    )
    assert(!existsSync(destination))
    assert.equal(readlinkSync(legacy), alias)
    rmSync(legacy)
    symlinkSync(modern, legacy)
    file(destination, 'fixture')
    await withSigning(context, async () => 0, home)
    assert.equal(readFileSync(destination, 'utf8'), 'fixture')
    writeFileSync(destination, 'different')
    await assert.rejects(
      withSigning(context, async () => 0, home),
      /preserving/
    )
    assert.equal(readFileSync(destination, 'utf8'), 'different')
    assert.equal(readlinkSync(legacy), modern)
  })
  it('rejects profile aliases outside the canonical location and symlinked modern directories', async () => {
    const home = path.join(root, 'home')
    const legacy = path.join(home, 'Library/MobileDevice/Provisioning Profiles')
    const modern = path.join(
      home,
      'Library/Developer/Xcode/UserData/Provisioning Profiles'
    )
    const other = path.join(root, 'other-profiles')
    mkdirSync(path.dirname(legacy), { recursive: true })
    mkdirSync(path.dirname(modern), { recursive: true })
    mkdirSync(other)
    const preserved = file(
      path.join(other, profile.uuid + '.mobileprovision'),
      'different'
    )
    symlinkSync(other, legacy)
    await assert.rejects(
      withSigning(
        context,
        async () => assert.fail('unsafe alias accepted'),
        home
      ),
      /symlinks/
    )
    assert.equal(readFileSync(preserved, 'utf8'), 'different')
    rmSync(legacy)
    symlinkSync(modern, legacy)
    symlinkSync(other, modern)
    await assert.rejects(
      withSigning(
        context,
        async () => assert.fail('unsafe modern directory accepted'),
        home
      ),
      /symlinks/
    )
    assert.equal(readFileSync(preserved, 'utf8'), 'different')
    assert.equal(readlinkSync(legacy), modern)
    assert.equal(readlinkSync(modern), other)
    assert.equal(readdirSync(context.output).length, 0)
  })
  it('rejects an alias whose normalized path hides a redirected component', async () => {
    const home = path.join(root, 'home')
    const legacy = path.join(home, 'Library/MobileDevice/Provisioning Profiles')
    const modern = path.join(
      home,
      'Library/Developer/Xcode/UserData/Provisioning Profiles'
    )
    mkdirSync(path.dirname(legacy), { recursive: true })
    mkdirSync(modern, { recursive: true })
    const other = path.join(root, 'external/nested')
    mkdirSync(other, { recursive: true })
    const redirect = path.join(home, 'Library/redirect')
    symlinkSync(other, redirect)
    const alias =
      '../redirect/../Developer/Xcode/UserData/Provisioning Profiles'
    assert.equal(path.resolve(path.dirname(legacy), alias), modern)
    symlinkSync(alias, legacy)
    await assert.rejects(
      withSigning(
        context,
        async () => assert.fail('hidden redirect accepted'),
        home
      ),
      /symlinks/
    )
    assert.equal(readlinkSync(legacy), alias)
    assert.equal(readlinkSync(redirect), other)
    assert.deepEqual(readdirSync(modern), [])
    assert.equal(readdirSync(context.output).length, 0)
  })
  it('archives and exports the actual target contract, verifies final IPA metadata, certificate, entitlements and JS', async () => {
    const result = await ios(context, path.join(root, 'home'))
    assert(result.file.endsWith('.ipa'))
    assert.equal(result.buildNumber, '26093004')
    assert(
      calls.some(c => c.file === 'bundle' && c.args.includes('--deployment'))
    )
    assert(calls.some(c => c.args.includes('generic/platform=iOS')))
    // The team and link host reach the archive through the app's xcconfig,
    // written by this tool's own script with the target's entitlements.
    const written = calls.find(c =>
      c.args[0]?.endsWith(path.join('scripts', 'clientConfig.mjs'))
    )
    assert.deepEqual(written?.args.slice(2), [
      '--entitlements',
      'TeamStation/TeamStation.entitlements'
    ])
    const archived = calls.find(
      c => c.file === 'xcodebuild' && c.args[0] === 'archive'
    )!
    assert.equal(
      archived.args[archived.args.indexOf('-xcconfig') + 1],
      path.join(context.source, 'clientConfig.xcconfig')
    )
    assert(
      calls.some(c =>
        c.args.includes('OTHER_SWIFT_FLAGS=$(inherited) -disable-cmo')
      )
    )
    assert.deepEqual(readdirSync(context.output), ['ios.ipa'])
    const projectFile = path.join(
      context.source,
      'ios',
      context.target.scheme! + '.xcodeproj/project.pbxproj'
    )
    assert.equal(readFileSync(projectFile, 'utf8'), 'user project bytes')
    context.output = path.join(root, 'second-output')
    mkdirSync(context.output)
    dispatch = async c => {
      if (c.args[0] === '-exportArchive') {
        file(path.join(c.args[4], 'other-app.ipa'))
        return ''
      }
      return c.args[0] === '-help' ? 'ad-hoc' : await fake(c)
    }
    await ios(context, path.join(root, 'home'))
    assert.equal(readFileSync(projectFile, 'utf8'), 'user project bytes')
    dispatch = async c => {
      if (c.file === 'xcodebuild' && c.args[0] === 'archive')
        throw new Error('archive failed')
      return await fake(c)
    }
    await assert.rejects(
      ios(context, path.join(root, 'home')),
      /archive failed/
    )
    assert.equal(readFileSync(projectFile, 'utf8'), 'user project bytes')
    const signing = {
      directory: root,
      keychain: 'fixture',
      profiles: new Map<string, Profile>()
    }
    const appPath = appTree(path.join(root, 'Example.app'))
    for (const override of [
      { CFBundleVersion: '2' },
      { CFBundleExecutable: '../escape' },
      { UIDeviceFamily: [] },
      { UIDeviceFamily: [8] }
    ]) {
      dispatch = async c =>
        c.file === 'plutil'
          ? JSON.stringify({ ...info(), ...override })
          : await fake(c)
      await assert.rejects(verifyApp(context, appPath, signing))
    }
    dispatch = async c => (c.file === 'xcrun' ? 'x86_64' : await fake(c))
    await assert.rejects(verifyApp(context, appPath, signing), /architectures/)
    dispatch = fake
    profile.certificates = []
    await assert.rejects(verifyApp(context, appPath, signing), /certificate/)
    profile.certificates = [
      createHash('sha256').update(certificate).digest('hex')
    ]
    rmSync(path.join(appPath, 'main.jsbundle'))
    await assert.rejects(verifyApp(context, appPath, signing), /JavaScript/)
    appTree(appPath)
    file(path.join(appPath, 'PlugIns/Example.appex/Info.plist'))
    await assert.rejects(verifyApp(context, appPath, signing), /Extension/)
    rmSync(path.join(context.source, 'ios/Podfile.lock'))
    await assert.rejects(archive(context, signing), /locked/)
    dispatch = async () => {
      throw new Error('failed')
    }
    await assert.rejects(ruby(context, 'project', {}, root))
    assert(!existsSync(path.join(root, 'project.json')))
  })
  it('uses pinned Ruby libraries to parse real profile XML and modify a generated Xcode project', async () => {
    Processes.prototype.run = original
    context.settings.tools.bundle = process.env.DEPLOY_TEST_BUNDLE ?? 'bundle'
    const env = { ...process.env, ...bundleEnvironment() }
    const project = path.join(root, 'Example.xcodeproj')
    execFileSync(
      context.settings.tools.bundle,
      [
        'exec',
        'ruby',
        '-e',
        `require 'xcodeproj'; p=Xcodeproj::Project.new(ARGV[0]);t=p.new_target(:application,'Example',:ios,'18.0');t.build_configurations.each{|c|c.build_settings['PRODUCT_BUNDLE_IDENTIFIER']=ARGV[1]};p.save`,
        project,
        app
      ],
      { env, stdio: 'pipe' }
    )
    await ruby(
      context,
      'project',
      {
        project,
        platform: 'ios',
        appId: app,
        teamId: team,
        identity: 'Fixture Distribution',
        keychain: path.join(root, 'keychain'),
        profiles: { [app]: 'Fixture' },
        number: '26093004',
        version: '1.2.3'
      },
      root
    )
    assert(
      readFileSync(path.join(project, 'project.pbxproj'), 'utf8').includes(
        'PROVISIONING_PROFILE_SPECIFIER = Fixture'
      )
    )
    const plist = path.join(root, 'profile.plist')
    writeFileSync(
      plist,
      `<plist version="1.0"><dict><key>UUID</key><string>${profile.uuid}</string><key>Name</key><string>Fixture</string><key>ExpirationDate</key><date>2099-01-01T00:00:00Z</date><key>TeamIdentifier</key><array><string>${team}</string></array><key>Platform</key><array><string>iOS</string></array><key>ProvisionedDevices</key><array><string>fixture-device</string></array><key>DeveloperCertificates</key><array><data>${certificate.toString('base64')}</data></array><key>Entitlements</key>${xml(profile.entitlements)}</dict></plist>`
    )
    assert.equal(
      validateProfile(
        JSON.parse(await ruby(context, 'profile', { file: plist }, root)),
        app,
        context
      ).certificates[0],
      profile.certificates[0]
    )
    const appPath = appTree(path.join(root, 'Real.app'))
    // The real system plist reader is exercised with a generated scalar-only plist.
    writeFileSync(
      path.join(appPath, 'Info.plist'),
      `<plist version="1.0">${xml({ CFBundleIdentifier: app, CFBundleVersion: '26093004', CFBundleShortVersionString: '1.2.3', CFBundleExecutable: 'Example' })}</plist>`
    )
    assert.equal((await readInfo(context, appPath)).CFBundleIdentifier, app)
  })
})
