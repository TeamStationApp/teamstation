import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { asObject, asOptional, asString } from 'cleaners'

import { privateJson, type Settings } from './config'
import type { Processes } from './process'

/**
 * Crash-report symbols for a build: the iOS and macOS dSYMs, the JavaScript
 * bundle with its Hermes source map, and an Android app's unstripped native
 * libraries, uploaded to Sentry for the release the build reports as, so a
 * stack names the function rather than an address or a minified line.
 *
 * An app opts in with a `sentry` block in the private deployment settings;
 * without one, nothing here runs and the build is exactly what it was.
 */

export type SentrySettings = NonNullable<Settings['apps'][string]['sentry']>

const asSentryToken = asObject({
  schemaVersion: (value: unknown): 1 => {
    if (value !== 1) throw new Error('Unsupported Sentry token file')
    return 1
  },
  origin: asString,
  token: asString,
  name: asOptional(asString)
})

/**
 * The release name a build's symbols are uploaded under. One formatter, shared
 * with the app and the server, so an event and its symbols always agree.
 */
export { sentryRelease } from '../../src/common/sentry/release'

/** What reaches the build: the DSN the bundle reports to, and nothing secret. */
export function sentryBuildEnvironment(
  sentry: SentrySettings | undefined
): NodeJS.ProcessEnv {
  return sentry == null ? {} : { TS_SENTRY_DSN: sentry.dsn }
}

/** sentry-cli's own variables, the token among them, so none is on a command line. */
export function sentryCliEnvironment(
  sentry: SentrySettings
): NodeJS.ProcessEnv {
  const credential = privateJson(sentry.tokenFile, asSentryToken)
  if (credential.origin !== sentry.origin)
    throw new Error('Sentry token file is for another server')
  return {
    SENTRY_URL: sentry.origin,
    SENTRY_ORG: sentry.org,
    SENTRY_PROJECT: sentry.project,
    SENTRY_AUTH_TOKEN: credential.token
  }
}

export interface SentryUploader {
  /** iOS or macOS debug symbols, from an archive's `dSYMs` or a build's products. */
  dsyms: (directory: string) => Promise<void>
  /**
   * A JavaScript bundle and its source map, under the name the app reports
   * frames by; the map's sources are named from `root`, the app's checkout.
   */
  bundle: (
    bundle: string,
    map: string,
    name: string,
    release: { release: string; dist?: string },
    root: string
  ) => Promise<void>
  /** An Android build's native libraries with their symbols. */
  nativeLibraries: (directory: string) => Promise<void>
}

export function sentryUploader(
  sentryCli: string,
  env: NodeJS.ProcessEnv,
  processes: Processes,
  cwd: string
): SentryUploader {
  async function run(step: string, args: string[], at = cwd): Promise<void> {
    try {
      await processes.run({
        file: sentryCli,
        args,
        cwd: at,
        env,
        capture: false
      })
    } catch {
      throw new Error(`Sentry upload failed: ${step}`)
    }
  }
  return {
    dsyms: async directory => {
      if (!existsSync(directory))
        throw new Error('Sentry upload failed: no dSYMs')
      await run('dSYMs', [
        'debug-files',
        'upload',
        '--include-sources',
        directory
      ])
    },
    bundle: async (bundle, map, name, release, root) => {
      if (!existsSync(bundle) || !existsSync(map))
        throw new Error('Sentry upload failed: no bundle or source map')
      // The app reports frames as `app:///<name>`; the files are uploaded under
      // that name from a directory of their own, whatever the build called them.
      const staging = mkdtempSync(path.join(os.tmpdir(), 'sentry-bundle-'))
      try {
        copyFileSync(bundle, path.join(staging, name))
        writeFileSync(
          path.join(staging, `${name}.map`),
          relativeSources(readFileSync(map, 'utf8'), root)
        )
        await run(
          'source map',
          [
            'sourcemaps',
            'upload',
            '--release',
            release.release,
            ...(release.dist == null ? [] : ['--dist', release.dist]),
            '--url-prefix',
            'app:///',
            '.'
          ],
          staging
        )
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    },
    nativeLibraries: async directory => {
      if (!existsSync(directory))
        throw new Error('Sentry upload failed: no native libraries')
      await run('native libraries', ['debug-files', 'upload', directory])
    }
  }
}

/**
 * A source map whose sources are named from the checkout, not from where it sat
 * on the machine that built it: under `root` becomes relative, and anything
 * else absolute keeps only its last `node_modules/` part.
 */
export function relativeSources(map: string, root: string): string {
  const parsed = JSON.parse(map) as { sources?: Array<string | null> }
  // A map names its sources absolutely, so a relative root is resolved first.
  const prefix = `${path.resolve(root)}/`
  parsed.sources = parsed.sources?.map(source => {
    // Source-map entries may be null when the source name is unknown. Keep
    // their indices and source-content alignment intact.
    if (source === null) return null
    if (source.startsWith(prefix)) return source.slice(prefix.length)
    const at = source.lastIndexOf('/node_modules/')
    if (source.startsWith('/') && at >= 0) return source.slice(at + 1)
    return source
  })
  return JSON.stringify(parsed)
}

/** The one `.app` an archive or a build produced. */
export function builtApp(directory: string): string {
  const apps = readdirSync(directory).filter(name => name.endsWith('.app'))
  if (apps.length !== 1) throw new Error('Expected one built app')
  return path.join(directory, apps[0])
}
