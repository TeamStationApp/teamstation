import { createHash, X509Certificate } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { asArray, asBoolean, asObject, asOptional, asString } from 'cleaners'

import { asAppleLogin, privateJson } from './config'
import { buildEnvironment, prepare } from './prepare'
import { Processes } from './process'
import { type BuildContext, type BuiltPackage, nativeNumber } from './runner'
import { noSymlinks } from './state'
import { text } from './validation'

const asProfile = asObject({
  uuid: (value: unknown): string => {
    const id = asString(value)
    if (!/^[A-Fa-f0-9-]{36}$/.test(id)) throw new Error('Invalid profile UUID')
    return id
  },
  name: asString,
  expires: asString,
  teams: asArray(asString),
  devices: asArray(asString),
  platforms: asArray(asString),
  certificates: asArray(asString),
  entitlements: asObject({
    'application-identifier': asString,
    'get-task-allow': asBoolean,
    'com.apple.developer.team-identifier': asString
  })
})
export type Profile = ReturnType<typeof asProfile>
const asInfo = asObject({
  CFBundleIdentifier: asString,
  CFBundleVersion: asString,
  CFBundleShortVersionString: asString,
  CFBundleExecutable: text(256),
  UIDeviceFamily: asOptional(
    asArray((value: unknown): number => {
      if (value !== 1 && value !== 2) throw new Error('Invalid device family')
      return value
    })
  )
})
export function bundleEnvironment(): NodeJS.ProcessEnv {
  return {
    BUNDLE_GEMFILE: path.join(__dirname, 'Gemfile'),
    BUNDLE_PATH: path.resolve(__dirname, '../../vendor/bundle'),
    BUNDLE_FROZEN: 'true',
    FASTLANE_SKIP_UPDATE_CHECK: '1',
    FASTLANE_HIDE_CHANGELOG: '1',
    FASTLANE_SKIP_DOCS: '1',
    FASTLANE_OPT_OUT_USAGE: '1'
  }
}
function quotedPaths(value: string): string[] {
  const lines = value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  return lines.map(line => {
    if (!/^"[^"\n]+"$/.test(line)) throw new Error('Invalid keychain list')
    return line.slice(1, -1)
  })
}
export function validateProfile(
  value: unknown,
  appId: string,
  context: BuildContext
): Profile {
  const profile = asProfile(value)
  const apple = context.settings.apps[context.target.app].ios?.apple
  if (
    apple?.profileNames[appId] == null ||
    profile.name !== apple.profileNames[appId] ||
    !profile.teams.includes(apple.teamId) ||
    !profile.platforms.includes('iOS') ||
    profile.entitlements['application-identifier'] !==
      `${apple.teamId}.${appId}` ||
    profile.entitlements['com.apple.developer.team-identifier'] !==
      apple.teamId ||
    profile.entitlements['get-task-allow'] ||
    !Number.isFinite(Date.parse(profile.expires)) ||
    Date.parse(profile.expires) <= Date.now() + 60000 ||
    profile.devices.length === 0 ||
    apple.requiredDevices.some(device => !profile.devices.includes(device))
  )
    throw new Error(
      'Signing profile identity, expiry or registered devices did not match'
    )
  return profile
}
export async function ruby(
  context: BuildContext,
  operation: string,
  value: object,
  directory: string,
  processes = context.processes
): Promise<string> {
  const file = path.join(directory, `${operation}.json`)
  const checkout = context.settings.match?.checkout
  if ((operation === 'match' || operation === 'import') && checkout != null) {
    noSymlinks(checkout)
    const stat = statSync(checkout)
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o777) !== 0o700 ||
      (process.getuid != null && stat.uid !== process.getuid())
    )
      throw new Error('Signing checkout must be private and owned')
  }
  let login: ReturnType<typeof asAppleLogin> | undefined
  const loginFile = context.settings.match?.appleLoginFile
  if (
    operation === 'import' &&
    context.settings.match?.apiKeyFile == null &&
    loginFile != null
  ) {
    login = privateJson(loginFile, asAppleLogin)
    login.cookieDirectory = path.resolve(
      path.dirname(loginFile),
      login.cookieDirectory
    )
    noSymlinks(login.cookieDirectory)
    const stat = statSync(login.cookieDirectory)
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o777) !== 0o700 ||
      (process.getuid != null && stat.uid !== process.getuid())
    )
      throw new Error('Apple session directory must be private and owned')
  }
  writeFileSync(
    file,
    JSON.stringify({
      ...value,
      ...(checkout == null ? {} : { checkout }),
      ...(login == null ? {} : { username: login.username })
    }),
    { mode: 0o600 }
  )
  try {
    return await processes.run({
      file: context.settings.tools.bundle,
      args: [
        'exec',
        'ruby',
        path.join(__dirname, 'apple-helper.rb'),
        operation,
        file
      ],
      cwd: directory,
      capture: operation !== 'match',
      env: {
        ...bundleEnvironment(),
        MATCH_PASSWORD: context.settings.match?.password,
        MATCH_KEYCHAIN_PASSWORD: context.settings.match?.keychainPassword,
        ...(operation === 'match' && context.settings.match?.p12Password != null
          ? { TS_MATCH_P12_PASSWORD: context.settings.match.p12Password }
          : {}),
        ...(login == null
          ? {}
          : {
              FASTLANE_PASSWORD: login.password,
              SPACESHIP_COOKIE_PATH: login.cookieDirectory
            })
      }
    })
  } finally {
    rmSync(file, { force: true })
  }
}
export interface Signing {
  keychain: string
  directory: string
  profiles: Map<string, Profile>
}
export async function withSigning<T>(
  context: BuildContext,
  action: (signing: Signing) => Promise<T>,
  profileHome = os.homedir()
): Promise<T> {
  const apple =
    context.settings.apps[context.target.app][context.target.platform]?.apple
  const match = context.settings.match
  if (
    apple == null ||
    match == null ||
    match.branch === 'master' ||
    match.branch === 'develop' ||
    match.branch === context.branch
  )
    throw new Error(
      'Separate Match signing branch and Apple settings are required'
    )
  const directory = mkdtempSync(path.join(context.output, '.signing-'))
  const keychain = path.join(directory, 'build.keychain-db')
  const processes = context.processes
  const cleanup = new Processes(new AbortController().signal)
  const security = async (
    args: string[],
    worker = processes
  ): Promise<string> =>
    await worker.run({
      file: context.settings.tools.security,
      args,
      cwd: directory
    })
  let original: string[] = []
  let defaultKeychain: string | undefined
  const installed: Array<{ file: string; bytes: Buffer }> = []
  let created = false
  try {
    original = quotedPaths(await security(['list-keychains', '-d', 'user']))
    defaultKeychain = quotedPaths(
      await security(['default-keychain', '-d', 'user'])
    )[0]
    await security(['create-keychain', '-p', match.keychainPassword, keychain])
    created = true
    await security(['unlock-keychain', '-p', match.keychainPassword, keychain])
    await security(['set-keychain-settings', '-lut', '21600', keychain])
    await security([
      'list-keychains',
      '-d',
      'user',
      '-s',
      ...original,
      keychain
    ])
    const profilesDirectory = path.join(directory, 'profiles')
    await ruby(
      context,
      'match',
      {
        ...match,
        password: undefined,
        keychainPassword: undefined,
        p12Password: undefined,
        type: context.target.platform === 'ios' ? 'adhoc' : 'developer_id',
        keychain,
        profilesDirectory,
        teamId: apple.teamId,
        appIds:
          context.target.platform === 'ios'
            ? Object.keys(apple.profileNames)
            : [context.target.app]
      },
      directory
    )
    const profiles = new Map<string, Profile>()
    if (context.target.platform === 'ios') {
      for (const name of readdirSync(profilesDirectory)) {
        if (!name.endsWith('.mobileprovision')) continue
        const file = path.join(profilesDirectory, name)
        noSymlinks(file)
        const xml = path.join(directory, 'profile.plist')
        const decoded = await security(['cms', '-D', '-i', file])
        writeFileSync(xml, decoded, { mode: 0o600 })
        const raw: unknown = JSON.parse(
          await ruby(context, 'profile', { file: xml }, directory)
        )
        const candidate = asProfile(raw)
        const id = candidate.entitlements['application-identifier'].slice(
          apple.teamId.length + 1
        )
        const profile = validateProfile(raw, id, context)
        profiles.set(id, profile)
        const bytes = readFileSync(file)
        for (const relative of [
          'Library/MobileDevice/Provisioning Profiles',
          'Library/Developer/Xcode/UserData/Provisioning Profiles'
        ]) {
          const destination = path.join(
            profileHome,
            relative,
            `${profile.uuid}.mobileprovision`
          )
          noSymlinks(destination)
          if (existsSync(destination)) {
            if (!readFileSync(destination).equals(bytes))
              throw new Error(
                'Existing provisioning profile differs; preserving it'
              )
          } else {
            mkdirSync(path.dirname(destination), { recursive: true })
            writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
            installed.push({ file: destination, bytes })
          }
        }
      }
      if (Object.keys(apple.profileNames).some(id => !profiles.has(id)))
        throw new Error('Match did not supply all requested profiles')
    }
    return await action({ keychain, directory, profiles })
  } finally {
    try {
      for (const item of installed) {
        noSymlinks(item.file)
        if (existsSync(item.file) && readFileSync(item.file).equals(item.bytes))
          rmSync(item.file)
      }
    } finally {
      try {
        if (created) {
          const current = quotedPaths(
            await security(['list-keychains', '-d', 'user'], cleanup)
          )
          await security(
            [
              'list-keychains',
              '-d',
              'user',
              '-s',
              ...current.filter(item => item !== keychain)
            ],
            cleanup
          )
          const currentDefault = quotedPaths(
            await security(['default-keychain', '-d', 'user'], cleanup)
          )[0]
          if (currentDefault === keychain && defaultKeychain != null)
            await security(
              ['default-keychain', '-d', 'user', '-s', defaultKeychain],
              cleanup
            )
          await security(['delete-keychain', keychain], cleanup)
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }
}
export function xml(value: unknown): string {
  if (typeof value === 'string')
    return `<string>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</string>`
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`
  if (value != null && typeof value === 'object')
    return `<dict>${Object.entries(value)
      .map(
        ([key, item]) =>
          `${xml(key).replace('<string>', '<key>').replace('</string>', '</key>')}${xml(item)}`
      )
      .join('')}</dict>`
  throw new Error('Unsupported property list value')
}
export async function readInfo(
  context: BuildContext,
  app: string
): Promise<ReturnType<typeof asInfo>> {
  const file = path.join(
    app,
    context.target.platform === 'macos' ? 'Contents/Info.plist' : 'Info.plist'
  )
  const value: unknown = JSON.parse(
    await context.processes.run({
      file: 'plutil',
      args: ['-convert', 'json', '-o', '-', file],
      cwd: context.source
    })
  )
  const info = asInfo(value)
  if (path.basename(info.CFBundleExecutable) !== info.CFBundleExecutable)
    throw new Error('Invalid app executable')
  return info
}
export async function archive(
  context: BuildContext,
  signing: Signing
): Promise<string> {
  const directory = await prepare(context)
  const apple =
    context.settings.apps[context.target.app][context.target.platform]!.apple!
  const env = { ...buildEnvironment(context), ...bundleEnvironment() }
  const isIos = context.target.platform === 'ios'
  if (context.target.kind === 'react-native') {
    if (!existsSync(path.join(directory, 'ios/Podfile.lock')))
      throw new Error('A locked CocoaPods graph is required')
    await context.processes.run({
      file: context.settings.tools.bundle,
      args: ['exec', 'pod', 'install', '--deployment'],
      cwd: path.join(directory, 'ios'),
      env,
      capture: false
    })
  }
  const project = path.join(
    directory,
    context.target.kind === 'react-native'
      ? `ios/${context.target.scheme}.xcodeproj`
      : `${context.target.scheme}.xcodeproj`
  )
  await ruby(
    context,
    'project',
    {
      project,
      platform: context.target.platform,
      appId: context.target.app,
      teamId: apple.teamId,
      identity: apple.identity,
      keychain: signing.keychain,
      profiles: apple.profileNames,
      number: nativeNumber(context.target.platform, context.buildNumber),
      version: context.version
    },
    signing.directory
  )
  const destination = path.join(
    directory,
    '.deploy',
    `${context.target.platform}.xcarchive`
  )
  const args = [
    'archive',
    ...(context.target.workspace == null
      ? ['-project', project]
      : ['-workspace', path.join(directory, context.target.workspace)]),
    '-scheme',
    context.target.scheme!,
    '-configuration',
    'Release',
    '-destination',
    isIos ? 'generic/platform=iOS' : 'generic/platform=macOS',
    '-archivePath',
    destination,
    '-derivedDataPath',
    path.join(directory, '.deploy/DerivedData'),
    'ONLY_ACTIVE_ARCH=NO',
    `ARCHS=${apple.architectures.join(' ')}`,
    `CURRENT_PROJECT_VERSION=${nativeNumber(context.target.platform, context.buildNumber)}`,
    `MARKETING_VERSION=${context.version}`,
    'OTHER_SWIFT_FLAGS=$(inherited) -disable-cmo',
    ...(isIos ? [] : ['ENABLE_HARDENED_RUNTIME=YES'])
  ]
  await context.processes.run({
    file: context.settings.tools.xcodebuild,
    args,
    cwd: directory,
    env,
    capture: false
  })
  return destination
}
export async function verifyApp(
  context: BuildContext,
  app: string,
  signing: Signing
): Promise<void> {
  const apple =
    context.settings.apps[context.target.app][context.target.platform]!.apple!
  const info = await readInfo(context, app)
  if (
    info.CFBundleIdentifier !== context.target.app ||
    info.CFBundleVersion !==
      nativeNumber(context.target.platform, context.buildNumber) ||
    info.CFBundleShortVersionString !== context.version
  )
    throw new Error('Apple package metadata did not match')
  await context.processes.run({
    file: context.settings.tools.codesign,
    args: ['--verify', '--deep', '--strict', app],
    cwd: signing.directory
  })
  const binary = path.join(
    app,
    context.target.platform === 'macos' ? 'Contents/MacOS' : '',
    info.CFBundleExecutable
  )
  const archs = (
    await context.processes.run({
      file: context.settings.tools.xcrun,
      args: ['lipo', '-archs', binary],
      cwd: signing.directory
    })
  ).split(/\s+/)
  if (
    apple.architectures.length === 0 ||
    apple.architectures.some(arch => !archs.includes(arch))
  )
    throw new Error('Package is missing configured architectures')
  if (context.target.platform === 'ios') {
    const expectedFamily =
      context.target.app === 'app.teamstation.director' ? 2 : 1
    if (info.UIDeviceFamily?.includes(expectedFamily) !== true)
      throw new Error('Wrong iOS device family')
    const profileFile = path.join(signing.directory, 'embedded.plist')
    writeFileSync(
      profileFile,
      await context.processes.run({
        file: context.settings.tools.security,
        args: ['cms', '-D', '-i', path.join(app, 'embedded.mobileprovision')],
        cwd: signing.directory
      }),
      { mode: 0o600 }
    )
    const profile = validateProfile(
      JSON.parse(
        await ruby(context, 'profile', { file: profileFile }, signing.directory)
      ),
      info.CFBundleIdentifier,
      context
    )
    const certificate = path.join(signing.directory, 'leaf')
    await context.processes.run({
      file: context.settings.tools.codesign,
      args: ['-d', '--extract-certificates', certificate, app],
      cwd: signing.directory
    })
    const certificateBytes = readFileSync(`${certificate}0`)
    const leaf = new X509Certificate(certificateBytes)
    if (
      !leaf.subject.split('\n').includes(`OU=${apple.teamId}`) ||
      !leaf.subject
        .split('\n')
        .some(line =>
          /^CN=(Apple Distribution|iPhone Distribution):/.test(line)
        ) ||
      Date.parse(leaf.validTo) <= Date.now() ||
      Date.parse(leaf.validFrom) > Date.now()
    )
      throw new Error('Distribution certificate identity or expiry is invalid')
    const digest = createHash('sha256').update(certificateBytes).digest('hex')
    if (!profile.certificates.includes(digest))
      throw new Error('App certificate is absent from provisioning profile')
    const entitlementsFile = path.join(signing.directory, 'entitlements.plist')
    writeFileSync(
      entitlementsFile,
      await context.processes.run({
        file: context.settings.tools.codesign,
        args: ['-d', '--entitlements', ':-', app],
        cwd: signing.directory
      }),
      { mode: 0o600 }
    )
    const entitlements = asProfile({
      ...profile,
      entitlements: JSON.parse(
        await context.processes.run({
          file: 'plutil',
          args: ['-convert', 'json', '-o', '-', entitlementsFile],
          cwd: signing.directory
        })
      )
    }).entitlements
    if (
      entitlements['get-task-allow'] ||
      entitlements['application-identifier'] !==
        profile.entitlements['application-identifier'] ||
      entitlements['com.apple.developer.team-identifier'] !== apple.teamId
    )
      throw new Error('Release entitlements did not match provisioning')
    if (
      context.target.kind === 'react-native' &&
      (!existsSync(path.join(app, 'main.jsbundle')) ||
        statSync(path.join(app, 'main.jsbundle')).size === 0)
    )
      throw new Error('Release IPA has no bundled JavaScript')
    // Current targets have no extensions. Reject additions until all identities are configured and verified.
    if (
      existsSync(path.join(app, 'PlugIns')) &&
      readdirSync(path.join(app, 'PlugIns')).some(name =>
        name.endsWith('.appex')
      )
    )
      throw new Error(
        'Extension verification must be configured before publication'
      )
  }
}
export async function ios(
  context: BuildContext,
  profileHome = os.homedir()
): Promise<BuiltPackage> {
  return await withSigning(
    context,
    async signing => {
      const archived = await archive(context, signing)
      const help = await context.processes.run({
        file: context.settings.tools.xcodebuild,
        args: ['-help'],
        cwd: context.source,
        captureStderr: true
      })
      const method = help.includes('release-testing')
        ? 'release-testing'
        : 'ad-hoc'
      const apple = context.settings.apps[context.target.app].ios!.apple!
      const options = path.join(signing.directory, 'ExportOptions.plist')
      writeFileSync(
        options,
        `<?xml version="1.0"?><plist version="1.0">${xml({ method, signingStyle: 'manual', teamID: apple.teamId, signingCertificate: apple.identity, provisioningProfiles: apple.profileNames, manageAppVersionAndBuildNumber: false, stripSwiftSymbols: true })}</plist>`,
        { mode: 0o600 }
      )
      const exported = path.join(context.source, '.deploy-export')
      await context.processes.run({
        file: context.settings.tools.xcodebuild,
        args: [
          '-exportArchive',
          '-archivePath',
          archived,
          '-exportPath',
          exported,
          '-exportOptionsPlist',
          options
        ],
        cwd: context.source,
        capture: false
      })
      const names = readdirSync(exported).filter(name => name.endsWith('.ipa'))
      if (names.length !== 1) throw new Error('Expected one exported IPA')
      const file = path.join(exported, names[0])
      const unpacked = path.join(signing.directory, 'unpacked')
      await context.processes.run({
        file: 'ditto',
        args: ['-x', '-k', file, unpacked],
        cwd: context.source
      })
      const payload = path.join(unpacked, 'Payload')
      const apps = readdirSync(payload).filter(name => name.endsWith('.app'))
      if (apps.length !== 1) throw new Error('Expected one IPA application')
      await verifyApp(context, path.join(payload, apps[0]), signing)
      return { file, buildNumber: nativeNumber('ios', context.buildNumber) }
    },
    profileHome
  )
}
