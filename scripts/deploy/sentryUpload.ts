import path from 'node:path'

import { Processes } from './process'
import { type SentryUploader, sentryUploader } from './sentry'

/**
 * The deploy tool's Sentry uploads, for a build made outside it:
 *
 *   node -r sucrase/register scripts/deploy/sentryUpload.ts --release <r> [--dist <d>]
 *     (--dsyms <dir> | --bundle <file> --map <file> --name <reported name> [--root <app checkout>]
 *      | --native-libs <dir>)
 *
 * SENTRY_URL, SENTRY_ORG, SENTRY_PROJECT and SENTRY_AUTH_TOKEN come from the
 * environment, and SENTRY_CLI names the binary when it is not on PATH.
 */

export type UploadRequest =
  | { kind: 'dsyms'; directory: string }
  | { kind: 'native-libs'; directory: string }
  | {
      kind: 'bundle'
      bundle: string
      map: string
      name: string
      release: string
      dist?: string
      root: string
    }

const USAGE =
  'usage: sentryUpload.ts --release <r> [--dist <d>] (--dsyms <dir> | --bundle <file> --map <file> --name <name> [--root <dir>] | --native-libs <dir>)'

export function parseUploadArgs(argv: string[]): UploadRequest {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!flag.startsWith('--') || value == null || value.startsWith('--'))
      throw new Error(USAGE)
    values.set(flag.slice(2), value)
  }
  const dsyms = values.get('dsyms')
  const nativeLibs = values.get('native-libs')
  const bundle = values.get('bundle')
  const chosen = [dsyms, nativeLibs, bundle].filter(value => value != null)
  if (chosen.length !== 1) throw new Error(USAGE)
  if (dsyms != null) return { kind: 'dsyms', directory: dsyms }
  if (nativeLibs != null) return { kind: 'native-libs', directory: nativeLibs }
  const map = values.get('map')
  const name = values.get('name')
  const release = values.get('release')
  if (bundle == null || map == null || name == null || release == null)
    throw new Error(USAGE)
  return {
    kind: 'bundle',
    bundle,
    map,
    name,
    release,
    dist: values.get('dist'),
    root: path.resolve(values.get('root') ?? process.cwd())
  }
}

export function requireSentryEnvironment(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of [
    'SENTRY_URL',
    'SENTRY_ORG',
    'SENTRY_PROJECT',
    'SENTRY_AUTH_TOKEN'
  ]) {
    const value = env[key]
    if (value == null || value === '') throw new Error(`${key} is not set`)
    out[key] = value
  }
  return out
}

export async function runUpload(
  request: UploadRequest,
  upload: SentryUploader
): Promise<void> {
  if (request.kind === 'dsyms') await upload.dsyms(request.directory)
  else if (request.kind === 'native-libs')
    await upload.nativeLibraries(request.directory)
  else
    await upload.bundle(
      request.bundle,
      request.map,
      request.name,
      { release: request.release, dist: request.dist },
      request.root
    )
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  processes: Processes
): Promise<void> {
  const request = parseUploadArgs(argv)
  await runUpload(
    request,
    sentryUploader(
      env.SENTRY_CLI ?? 'sentry-cli',
      requireSentryEnvironment(env),
      processes,
      process.cwd()
    )
  )
}

if (require.main === module)
  main(
    process.argv.slice(2),
    process.env,
    new Processes(new AbortController().signal)
  ).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
