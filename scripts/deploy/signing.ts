import { mkdtempSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { asBoolean, asObject } from 'cleaners'

import { ruby } from './apple'
import { loadSettings } from './config'
import { Processes } from './process'
import { type BuildContext, options } from './runner'
import { noSymlinks, ownedDirectory, State } from './state'
import { target } from './targets'

export function githubRepository(value: string): string {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      value
    )
  if (match == null)
    throw new Error(
      'Signing imports require a verifiably private GitHub repository'
    )
  return match[1]
}
export async function importSigning(
  args: string[],
  signal: AbortSignal
): Promise<void> {
  const selected = options(args)
  if (
    selected.platforms.length !== 1 ||
    selected.platforms[0] === 'android' ||
    selected.dryRun ||
    selected.publishOnly != null
  )
    throw new Error('Select one Apple platform for signing import')
  const settings = loadSettings(selected.config, selected.branch)
  const platform = selected.platforms[0]
  const apple = settings.apps[selected.app]?.[platform]?.apple
  const match = settings.match
  const files = match?.imports[platform]
  if (
    apple == null ||
    match == null ||
    files == null ||
    ['master', 'develop', selected.branch].includes(match.branch)
  )
    throw new Error(
      'A separate signing branch and explicit import files are required'
    )
  if (match.apiKeyFile == null && match.appleLoginFile == null)
    throw new Error('Signing import requires an API key or private Apple login')
  for (const file of [
    files.certificate,
    files.privateKey,
    files.profile,
    files.appStoreProfile,
    match.apiKeyFile,
    match.appleLoginFile,
    match.gitPrivateKey
  ]) {
    if (file == null) continue
    noSymlinks(file)
    const stat = statSync(file)
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid != null && stat.uid !== process.getuid())
    )
      throw new Error('Signing import files must be private regular files')
  }
  if (
    platform === 'ios' &&
    files.profile == null &&
    files.appStoreProfile == null
  )
    throw new Error('An ad-hoc or App Store provisioning profile is required')
  const processes = new Processes(signal)
  const visibility = asObject({ isPrivate: asBoolean })(
    JSON.parse(
      await processes.run({
        file: settings.tools.gh,
        args: [
          'repo',
          'view',
          githubRepository(match.repository),
          '--json',
          'isPrivate'
        ],
        cwd: settings.repository
      })
    )
  )
  if (!visibility.isPrivate)
    throw new Error('Signing repository must be private')
  const state = new State(settings.stateDirectory)
  let directory: string | undefined
  try {
    directory = mkdtempSync(
      path.join(
        ownedDirectory(settings.outputDirectory, 'output'),
        '.signing-import-'
      )
    )
    const context: BuildContext = {
      source: settings.repository,
      output: directory,
      settings,
      target: target(selected.app, platform),
      branch: selected.branch,
      commit: '0'.repeat(40),
      version: settings.apps[selected.app].version ?? '0.0.0',
      buildNumber: 1,
      buildTime: new Date().toISOString(),
      processes
    }
    const { appStoreProfile, ...adHoc } = files
    const request = {
      repository: match.repository,
      branch: match.branch,
      apiKeyFile: match.apiKeyFile,
      gitPrivateKey: match.gitPrivateKey,
      profilesDirectory: path.join(directory, 'profiles'),
      type: platform === 'ios' ? 'adhoc' : 'developer_id',
      teamId: apple.teamId,
      appIds: [selected.app],
      keychain: path.join(directory, 'unused.keychain'),
      ...adHoc
    }
    // An App Store profile can be imported on its own, so a newer ad-hoc
    // profile already in the repository is never replaced by an older file.
    if (platform !== 'ios' || adHoc.profile != null)
      await ruby(context, 'import', request, directory)
    // The App Store profile shares the distribution certificate and key; Match
    // stores it under its own type.
    if (platform === 'ios' && appStoreProfile != null)
      await ruby(
        context,
        'import',
        { ...request, type: 'appstore', profile: appStoreProfile },
        directory
      )
  } finally {
    if (directory != null) rmSync(directory, { recursive: true, force: true })
    state.close()
  }
}
export async function signingMain(args: string[]): Promise<number> {
  const cancel = new AbortController()
  const stop = (): void => {
    cancel.abort()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await importSigning(args, cancel.signal)
    console.log(
      'Encrypted signing assets were imported and the remote commit was verified'
    )
    return 0
  } catch {
    console.error(
      'Signing import failed. Check private repository, import files and Apple authorization.'
    )
    return 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
if (require.main === module)
  signingMain(process.argv.slice(2))
    .then(code => {
      process.exitCode = code
    })
    .catch(() => {
      process.exitCode = 1
    })
