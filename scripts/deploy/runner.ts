import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync
} from 'node:fs'
import path from 'node:path'

import { allocateBuildNumber, packageVersion } from './buildNumber'
import { loadSettings, type Settings } from './config'
import { Processes } from './process'
import { currentSource } from './source'
import {
  type Artifact,
  asRun,
  createOutput,
  noSymlinks,
  type Run,
  runId,
  State
} from './state'
import { type Target, target } from './targets'
import { fingerprint, upload } from './upload'
import {
  appId,
  branchName,
  httpsOrigin,
  object,
  type Platform,
  platform
} from './validation'

export interface Options {
  config: string
  app: string
  branch: string
  platforms: Platform[]
  buildNumberFile?: string
  dryRun: boolean
  publishOnly?: string
}
export function options(args: string[]): Options {
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (
      ![
        '--config',
        '--build-number-file',
        '--app',
        '--branch',
        '--platform',
        '--dry-run',
        '--publish-only'
      ].includes(key) ||
      values.has(key)
    )
      throw new Error('Unknown or duplicate deployment option')
    if (key === '--dry-run') values.set(key, 'true')
    else {
      const value = args[++i]
      if (value == null || value.startsWith('--'))
        throw new Error('Missing deployment option')
      values.set(key, value)
    }
  }
  const platforms = (values.get('--platform') ?? '').split(',').map(platform)
  if (new Set(platforms).size !== platforms.length)
    throw new Error('Duplicate platform')
  const out = {
    config: values.get('--config') ?? 'deployConfig.json',
    buildNumberFile: values.get('--build-number-file'),
    app: appId(values.get('--app')),
    branch: branchName(values.get('--branch')),
    platforms,
    dryRun: values.has('--dry-run'),
    publishOnly: values.has('--publish-only')
      ? runId(values.get('--publish-only'))
      : undefined
  }
  if (out.dryRun && out.publishOnly != null)
    throw new Error('Choose dry-run or publish-only')
  for (const os of platforms) target(out.app, os)
  return out
}
export interface BuildContext {
  source: string
  output: string
  settings: Settings
  target: Target
  branch: string
  commit: string
  version: string
  buildNumber: number
  buildTime: string
  processes: Processes
}
export interface BuiltPackage {
  file: string
  buildNumber: string
}
export type Builder = (context: BuildContext) => Promise<BuiltPackage>
export type Builders = Partial<Record<Platform, Builder>>
export function nativeNumber(_platform: Platform, value: number): string {
  return String(value)
}
function legacyNativeNumber(platform: Platform, value: number): string {
  if (platform === 'android') return String(value)
  if (value > 99989999) throw new Error('Apple build number range exhausted')
  // Three components preserve ordering within Apple's four/two/two digit bounds.
  return `${Math.floor(value / 10000) + 1}.${Math.floor(value / 100) % 100}.${value % 100}`
}
export async function run(
  options: Options,
  builders: Builders,
  signal: AbortSignal,
  output: (line: string) => void = console.log,
  workingDirectory = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const settings = loadSettings(options.config, options.branch)
  const configured = settings.apps[options.app]
  if (
    configured == null ||
    options.platforms.some(os => configured[os] == null)
  )
    throw new Error('App/platform is missing deployment settings')
  if (options.publishOnly == null && environment.APP_SERVER_URL != null) {
    const value = environment.APP_SERVER_URL
    configured.apiOrigin = httpsOrigin(
      value.includes('://') ? value : `https://${value}`
    )
  }
  const processes = new Processes(signal)
  if (options.dryRun) {
    const { commit } = await currentSource(
      settings,
      target(options.app, options.platforms[0]),
      processes,
      workingDirectory
    )
    output(`Validate ${options.app} at ${options.branch} (${commit})`)
    for (const os of options.platforms)
      output(
        `Build, verify and upload ${os} through ${configured[os]!.upload.kind}`
      )
    return 0
  }
  if (options.publishOnly == null && options.buildNumberFile == null)
    throw new Error('A shared --build-number-file is required')
  const state = new State(settings.stateDirectory)
  let releaseSleep: (() => void) | undefined
  try {
    state.prune(settings.outputDirectory)
    releaseSleep = settings.inhibitSleep
      ? await processes.inhibit(settings.tools.caffeinate, workingDirectory)
      : undefined
    let record: Run, directory: string
    if (options.publishOnly != null) {
      record = state.load(options.publishOnly)
      if (
        record.app !== options.app ||
        record.branch !== options.branch ||
        options.platforms.some(os => !record.platforms.includes(os))
      )
        throw new Error('Run does not match requested app, branch or platforms')
      directory = path.join(settings.outputDirectory, record.id)
      noSymlinks(directory)
      const marker = object({ id: runId })(
        JSON.parse(readFileSync(path.join(directory, '.run'), 'utf8'))
      )
      if (marker.id !== record.id) throw new Error('Output ownership changed')
    } else {
      const id = randomBytes(16).toString('hex')
      const source = await currentSource(
        settings,
        target(options.app, options.platforms[0]),
        processes,
        workingDirectory
      )
      const version = packageVersion(source.directory)
      const buildTime = new Date()
      const buildNumber = allocateBuildNumber(
        options.buildNumberFile!,
        source.directory,
        options.branch,
        buildTime
      )
      record = asRun({
        id,
        app: options.app,
        branch: options.branch,
        commit: source.commit,
        createdAt: buildTime.getTime(),
        version,
        buildNumberFormat: 'date',
        platforms: options.platforms,
        artifacts: [],
        failed: []
      })
      directory = createOutput(settings.outputDirectory, id)
      try {
        state.save(record)
      } catch (error) {
        rmSync(directory, { recursive: true, force: true })
        throw error
      }
      output(`Build run ${id} pinned to ${source.commit}`)
      for (const os of options.platforms) {
        if (signal.aborted) break
        const selected = target(options.app, os)
        try {
          const builder = builders[os]
          if (builder == null)
            throw new Error('Signed build adapter is unavailable')
          const built = await builder({
            source: source.directory,
            output: directory,
            settings,
            target: selected,
            branch: record.branch,
            commit: source.commit,
            version: record.version,
            buildNumber,
            buildTime: new Date(record.createdAt).toISOString(),
            processes
          })
          if (built.buildNumber !== nativeNumber(os, buildNumber))
            throw new Error('Package build number did not match allocation')
          const format = os === 'ios' ? 'ipa' : os === 'android' ? 'apk' : 'dmg'
          const name = `${os}.${format}`
          const destination = path.join(directory, name)
          noSymlinks(built.file)
          if (path.resolve(built.file) !== destination)
            copyFileSync(built.file, destination, 1)
          chmodSync(destination, 0o400)
          const checksum = await fingerprint(destination)
          record.artifacts.push({
            platform: os,
            file: name,
            version: record.version,
            buildNumber,
            published: undefined,
            error: undefined,
            ...checksum
          })
        } catch {
          record.failed.push(os)
          output(`${os} build failed; no package was published`)
        }
        state.save(record)
      }
    }
    for (const os of options.platforms) {
      const artifact: Artifact | undefined = record.artifacts.find(
        item => item.platform === os
      )
      if (artifact == null || signal.aborted) continue
      if (artifact.published != null) {
        output(`${os} was already published`)
        continue
      }
      try {
        if (path.basename(artifact.file) !== artifact.file)
          throw new Error('Invalid saved artifact path')
        const file = path.join(directory, artifact.file)
        if (!existsSync(file)) throw new Error('Saved package has expired')
        artifact.published = await upload(
          configured[os]!.upload,
          {
            file,
            bundleId: record.app,
            version: artifact.version,
            buildNumber:
              record.buildNumberFormat === 'date'
                ? nativeNumber(os, artifact.buildNumber)
                : legacyNativeNumber(os, artifact.buildNumber),
            branch: record.branch,
            commit: record.commit,
            buildTime: new Date(record.createdAt).toISOString(),
            size: artifact.size,
            digest: artifact.digest
          },
          signal
        )
        delete artifact.error
        output(`${os} uploaded`)
      } catch {
        artifact.error = 'Upload failed; retry this run with publish-only'
        output(`${os} upload failed; package retained for retry`)
      }
      state.save(record)
    }
    return !signal.aborted &&
      options.platforms.every(os =>
        record.artifacts.some(
          item => item.platform === os && item.published != null
        )
      )
      ? 0
      : 1
  } finally {
    releaseSleep?.()
    state.close()
  }
}
