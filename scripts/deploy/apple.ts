import { createHash, X509Certificate } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { asArray, asBoolean, asObject, asOptional, asString } from 'cleaners'

import { asAppleLogin, privateJson, type Settings } from './config'
import { buildEnvironment, prepare } from './prepare'
import { Processes } from './process'
import { type BuildContext, type BuiltPackage, nativeNumber } from './runner'
import {
  builtApp,
  sentryCliEnvironment,
  sentryRelease,
  sentryUploader
} from './sentry'
import { noSymlinks } from './state'
import { apiKey } from './testflight'
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
  provisionsAllDevices: asOptional(asBoolean),
  platforms: asArray(asString),
  certificates: asArray(asString),
  entitlements: asObject({
    'application-identifier': asString,
    'get-task-allow': asBoolean,
    'com.apple.developer.team-identifier': asString
  })
})
/** Only an enterprise profile says whether it provisions every device. */
export type Profile = Omit<
  ReturnType<typeof asProfile>,
  'provisionsAllDevices'
> & {
  provisionsAllDevices?: boolean
}
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
/**
 * Ad-hoc profiles carry the registered devices; App Store profiles carry
 * none, and must not be an enterprise profile that installs everywhere.
 */
export type ProfileKind = 'adHoc' | 'appStore'
export function validateProfile(
  value: unknown,
  appId: string,
  context: BuildContext,
  kind: ProfileKind = 'adHoc'
): Profile {
  const profile = asProfile(value)
  const apple = context.settings.apps[context.target.app].ios?.apple
  const names =
    kind === 'adHoc' ? apple?.profileNames : apple?.appStoreProfileNames
  if (
    apple == null ||
    names?.[appId] == null ||
    profile.name !== names[appId] ||
    !profile.teams.includes(apple.teamId) ||
    !profile.platforms.includes('iOS') ||
    profile.entitlements['application-identifier'] !==
      `${apple.teamId}.${appId}` ||
    profile.entitlements['com.apple.developer.team-identifier'] !==
      apple.teamId ||
    profile.entitlements['get-task-allow'] ||
    !Number.isFinite(Date.parse(profile.expires)) ||
    Date.parse(profile.expires) <= Date.now() + 60000 ||
    (kind === 'adHoc'
      ? profile.devices.length === 0 ||
        apple.requiredDevices.some(device => !profile.devices.includes(device))
      : profile.devices.length > 0 || profile.provisionsAllDevices === true)
  ) {
    const expected = names?.[appId] ?? ''
    const missing =
      apple == null
        ? -1
        : apple.requiredDevices.filter(
            device => !profile.devices.includes(device)
          ).length
    const flags = [
      apple == null ? 'apple' : '',
      names?.[appId] == null ? 'missingName' : '',
      profile.name !== expected ? 'name' : '',
      apple != null && !profile.teams.includes(apple.teamId) ? 'team' : '',
      !profile.platforms.includes('iOS') ? 'platform' : '',
      profile.entitlements['get-task-allow'] ? 'task' : '',
      !Number.isFinite(Date.parse(profile.expires)) ||
      Date.parse(profile.expires) <= Date.now() + 60000
        ? 'expiry'
        : '',
      missing !== 0 && kind === 'adHoc' ? 'devices' : ''
    ].filter(flag => flag !== '')
    throw new Error(
      'Signing profile did not match ' +
        flags.join(',') +
        ' uuid=' +
        profile.uuid +
        ' n=' +
        String(profile.devices.length) +
        ' missing=' +
        String(missing)
    )
  }
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
  /** The App Store profiles, fetched only for an app that goes to TestFlight. */
  appStoreProfiles?: Map<string, Profile>
}
function profileDirectories(home: string): string[] {
  const legacy = path.resolve(
    home,
    'Library/MobileDevice/Provisioning Profiles'
  )
  const modern = path.resolve(
    home,
    'Library/Developer/Xcode/UserData/Provisioning Profiles'
  )
  // Xcode can retain its old location as an alias of the new one. Leave the
  // alias untouched and install directly into its verified canonical directory.
  if (
    lstatSync(legacy, { throwIfNoEntry: false })?.isSymbolicLink() === true &&
    [modern, path.relative(path.dirname(legacy), modern)].includes(
      readlinkSync(legacy)
    )
  ) {
    noSymlinks(path.dirname(legacy))
    noSymlinks(modern)
    return [modern]
  }
  return [legacy, modern]
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
    // Fetches one Match type's profiles into its own directory and installs
    // each for Xcode once it is verified as that kind.
    const fetch = async (
      type: string,
      profilesDirectory: string,
      names: Record<string, string>,
      kind: ProfileKind
    ): Promise<Map<string, Profile>> => {
      await ruby(
        context,
        'match',
        {
          ...match,
          password: undefined,
          keychainPassword: undefined,
          p12Password: undefined,
          type,
          keychain,
          profilesDirectory,
          teamId: apple.teamId,
          appIds:
            context.target.platform === 'ios'
              ? Object.keys(names)
              : [context.target.app]
        },
        directory
      )
      const profiles = new Map<string, Profile>()
      if (context.target.platform !== 'ios') return profiles
      const note = path.join(profilesDirectory, 'profile-note.txt')
      if (existsSync(note))
        console.log('PROFILE note ' + readFileSync(note, 'utf8').trim())
      const chosen = readdirSync(profilesDirectory).filter(name =>
        /^chosen-\d+\.cms$/.test(name)
      )
      const entries =
        chosen.length > 0
          ? chosen
          : readdirSync(profilesDirectory).filter(name =>
              name.endsWith('.mobileprovision')
            )
      console.log('PROFILE files ' + entries.join(' '))
      for (const name of entries) {
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
        const profile = validateProfile(raw, id, context, kind)
        profiles.set(id, profile)
        const bytes = readFileSync(file)
        for (const profileDirectory of profileDirectories(profileHome)) {
          const destination = path.join(
            profileDirectory,
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
      if (Object.keys(names).some(id => !profiles.has(id)))
        throw new Error('Match did not supply all requested profiles')
      return profiles
    }
    const profiles = await fetch(
      context.target.platform === 'ios' ? 'adhoc' : 'developer_id',
      path.join(directory, 'profiles'),
      apple.profileNames,
      'adHoc'
    )
    const testflight = testflightSettings(context)
    if (testflight == null)
      return await action({ keychain, directory, profiles })
    if (apple.appStoreProfileNames == null)
      throw new Error('TestFlight needs iOS App Store profiles')
    const appStoreProfiles = await fetch(
      'appstore',
      path.join(directory, 'appStoreProfiles'),
      apple.appStoreProfileNames,
      'appStore'
    )
    return await action({ keychain, directory, profiles, appStoreProfiles })
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
  // The token file is read before the archive, so a bad one fails in seconds.
  const sentry = context.settings.apps[context.target.app].sentry
  const sentryEnvironment =
    sentry == null ? undefined : sentryCliEnvironment(sentry)
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
  const projectFile = path.join(project, 'project.pbxproj')
  noSymlinks(projectFile)
  const originalProject = readFileSync(projectFile)
  try {
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
    // The team and the app link host, from the clientConfig.json `prepare`
    // wrote. The script is this tool's own, found beside it, because the app
    // being built may come from another repository.
    const xcconfig = (
      await context.processes.run({
        file: context.settings.tools.node,
        args: [
          path.join(__dirname, '../clientConfig.mjs'),
          directory,
          ...(context.target.entitlements == null
            ? []
            : ['--entitlements', context.target.entitlements])
        ],
        cwd: directory,
        env
      })
    ).trim()
    const destination = path.join(
      directory,
      '.deploy',
      `${context.target.platform}.xcarchive`
    )
    // React Native's bundle phase writes the composed Hermes map where this
    // names, for the upload after the archive.
    const sourceMap =
      sentry != null && context.target.kind === 'react-native'
        ? path.join(directory, '.deploy', 'main.jsbundle.map')
        : undefined
    const args = [
      'archive',
      ...(context.target.workspace == null
        ? ['-project', project]
        : ['-workspace', path.join(directory, context.target.workspace)]),
      '-scheme',
      context.target.scheme!,
      '-xcconfig',
      xcconfig,
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
      ...(isIos ? [] : ['ENABLE_HARDENED_RUNTIME=YES']),
      ...(sourceMap == null ? [] : [`SOURCEMAP_FILE=${sourceMap}`])
    ]
    await context.processes.run({
      file: context.settings.tools.xcodebuild,
      args,
      cwd: directory,
      env,
      capture: false
    })
    if (sentryEnvironment != null) {
      const upload = sentryUploader(
        context.settings.tools.sentryCli,
        sentryEnvironment,
        context.processes,
        directory
      )
      await upload.dsyms(path.join(destination, 'dSYMs'))
      if (sourceMap != null) {
        const app = builtApp(path.join(destination, 'Products/Applications'))
        await upload.bundle(
          path.join(app, 'main.jsbundle'),
          sourceMap,
          'main.jsbundle',
          sentryRelease(
            context.target.app,
            context.version,
            nativeNumber(context.target.platform, context.buildNumber)
          ),
          directory
        )
      }
    }
    return destination
  } finally {
    writeFileSync(projectFile, originalProject)
  }
}
export async function verifyApp(
  context: BuildContext,
  app: string,
  signing: Signing,
  kind: ProfileKind = 'adHoc'
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
      context,
      kind
    )
    const certificate = path.join(signing.directory, 'leaf')
    await context.processes.run({
      file: context.settings.tools.codesign,
      args: ['-d', `--extract-certificates=${certificate}`, app],
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
/** Where one export's options, IPA and unpacked app go in the signing directory. */
interface ExportNames {
  options: string
  exported: string
  unpacked: string
}
/**
 * Exports the archive with these options, checks the one IPA it holds as a
 * `kind` build, and returns that IPA.
 */
async function exportIpa(
  context: BuildContext,
  signing: Signing,
  archived: string,
  options: object,
  names: ExportNames,
  kind: ProfileKind
): Promise<string> {
  const plist = path.join(signing.directory, names.options)
  writeFileSync(
    plist,
    `<?xml version="1.0"?><plist version="1.0">${xml(options)}</plist>`,
    { mode: 0o600 }
  )
  const exported = path.join(signing.directory, names.exported)
  await context.processes.run({
    file: context.settings.tools.xcodebuild,
    args: [
      '-exportArchive',
      '-archivePath',
      archived,
      '-exportPath',
      exported,
      '-exportOptionsPlist',
      plist
    ],
    cwd: context.source,
    capture: false
  })
  const ipas = readdirSync(exported).filter(item => item.endsWith('.ipa'))
  if (ipas.length !== 1) throw new Error('Expected one exported IPA')
  const file = path.join(exported, ipas[0])
  const unpacked = path.join(signing.directory, names.unpacked)
  await context.processes.run({
    file: 'ditto',
    args: ['-x', '-k', file, unpacked],
    cwd: context.source
  })
  const payload = path.join(unpacked, 'Payload')
  const apps = readdirSync(payload).filter(item => item.endsWith('.app'))
  if (apps.length !== 1) throw new Error('Expected one IPA application')
  await verifyApp(context, path.join(payload, apps[0]), signing, kind)
  return file
}
/**
 * The app's TestFlight settings, for a build of `master` only. Build numbers
 * count per branch, and App Store Connect wants each one higher than the last
 * for a version, so one branch owns the TestFlight numbers. A branch without
 * settings of its own reads master's, testflight block included; this keeps
 * its builds off TestFlight.
 */
export function testflightSettings(
  context: BuildContext
): NonNullable<Settings['apps'][string]['ios']>['testflight'] {
  if (context.target.platform !== 'ios' || context.branch !== 'master')
    return undefined
  return context.settings.apps[context.target.app].ios?.testflight
}
export async function ios(
  context: BuildContext,
  profileHome = os.homedir()
): Promise<BuiltPackage> {
  // The key is read before the archive, so a bad one fails in seconds.
  const testflight = testflightSettings(context)
  if (testflight != null) apiKey(testflight.apiKeyFile)
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
      // The ad-hoc IPA is the one builds.teamstation.app serves.
      const file = await exportIpa(
        context,
        signing,
        archived,
        {
          method,
          signingStyle: 'manual',
          teamID: apple.teamId,
          signingCertificate: apple.identity,
          provisioningProfiles: apple.profileNames,
          manageAppVersionAndBuildNumber: false,
          stripSwiftSymbols: true
        },
        {
          options: 'ExportOptions.plist',
          exported: 'export',
          unpacked: 'unpacked'
        },
        'adHoc'
      )
      const retained = path.join(context.output, 'ios.ipa')
      if (testflight == null) {
        copyFileSync(file, retained, 1)
        return {
          file: retained,
          buildNumber: nativeNumber('ios', context.buildNumber)
        }
      }
      // The same archive, signed for App Store Connect, goes to TestFlight.
      const store = await exportIpa(
        context,
        signing,
        archived,
        {
          method: 'app-store-connect',
          signingStyle: 'manual',
          teamID: apple.teamId,
          signingCertificate: apple.identity,
          provisioningProfiles: apple.appStoreProfileNames,
          manageAppVersionAndBuildNumber: false,
          uploadSymbols: true,
          stripSwiftSymbols: true
        },
        {
          options: 'AppStoreExportOptions.plist',
          exported: 'appStoreExport',
          unpacked: 'appStoreUnpacked'
        },
        'appStore'
      )
      const retainedStore = path.join(context.output, 'ios-appstore.ipa')
      copyFileSync(file, retained, 1)
      copyFileSync(store, retainedStore, 1)
      return {
        file: retained,
        buildNumber: nativeNumber('ios', context.buildNumber),
        testflight: retainedStore
      }
    },
    profileHome
  )
}
