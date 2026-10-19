import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { privateJson } from './config'
import { DeploymentToolError, type Processes } from './process'
import { redact, rememberSecret } from './redact'
import { noSymlinks } from './state'
import { object, text } from './validation'

/** The App Store Connect API key file: `{ keyId, issuerId, keyFile }`. */
const asApiKey = object({
  keyId: text(64),
  issuerId: text(64),
  keyFile: text()
})
export type ApiKey = ReturnType<typeof asApiKey>

function privateFile(file: string): void {
  noSymlinks(file)
  if (!statSync(file).isFile() || (statSync(file).mode & 0o077) !== 0)
    throw new Error('TestFlight API key files must be private regular files')
}

/**
 * Reads the API key file, whose `keyFile` is relative to it. The `.p8` is
 * read only so that a tool echoing it is redacted; altool gets its path.
 */
export function apiKey(file: string): ApiKey {
  privateFile(file)
  const key = privateJson(file, asApiKey)
  key.keyFile = path.resolve(path.dirname(file), key.keyFile)
  privateFile(key.keyFile)
  const pem = readFileSync(key.keyFile, 'utf8').trim()
  if (!pem.startsWith('-----BEGIN PRIVATE KEY-----'))
    throw new Error('TestFlight API key is not a private key')
  rememberSecret(pem)
  rememberSecret(pem.replace(/-----[A-Z ]+-----|\s/g, ''))
  return key
}

/** What App Store Connect says when this build number is already there. */
const duplicate =
  /Redundant Binary Upload|already (?:been )?uploaded a build|bundle version must be higher|has already been used|ENTITY_ERROR\.ATTRIBUTE\.INVALID\.DUPLICATE/i

export interface TestFlightUpload {
  ipa: string
  apiKey: ApiKey
  appleId: string
  bundleId: string
  version: string
  buildNumber: string
  processes: Processes
  tools: { xcrun: string }
}

/**
 * Uploads an App Store IPA to App Store Connect, where it becomes a
 * TestFlight build. A build number Apple already holds counts as published,
 * so a retried run succeeds.
 *
 * Xcode 26's altool takes the key by path (`--p8-file-path`), so the `.p8`
 * stays in its private directory rather than a `private_keys` search path.
 * Its help no longer lists the identity flags for an upload, but its parser
 * still knows them; they pin the upload to this app and build.
 */
export async function uploadToTestFlight(
  upload: TestFlightUpload
): Promise<{ alreadyPublished: boolean }> {
  const file = upload.tools.xcrun
  let output: string
  try {
    output = await upload.processes.run({
      file,
      args: [
        'altool',
        '--upload-package',
        upload.ipa,
        '--type',
        'ios',
        '--apple-id',
        upload.appleId,
        '--bundle-id',
        upload.bundleId,
        '--bundle-version',
        upload.buildNumber,
        '--bundle-short-version-string',
        upload.version,
        '--api-key',
        upload.apiKey.keyId,
        '--api-issuer',
        upload.apiKey.issuerId,
        '--p8-file-path',
        upload.apiKey.keyFile,
        '--output-format',
        'json'
      ],
      cwd: path.dirname(upload.ipa)
    })
  } catch (error) {
    // A failed altool's output is reachable only redacted.
    if (
      error instanceof DeploymentToolError &&
      duplicate.test(error.lastLines(400).join('\n'))
    )
      return { alreadyPublished: true }
    throw error
  }
  let result: unknown
  try {
    result = JSON.parse(output.slice(output.indexOf('{')))
  } catch {
    result = undefined
  }
  const fields =
    result != null && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : {}
  const errors = JSON.stringify(fields['product-errors'] ?? [])
  if (errors !== '[]' && duplicate.test(errors))
    return { alreadyPublished: true }
  if (errors === '[]' && typeof fields['success-message'] === 'string')
    return { alreadyPublished: false }
  throw new DeploymentToolError(
    'TestFlight upload was not confirmed',
    file,
    undefined,
    undefined,
    redact(output)
  )
}
