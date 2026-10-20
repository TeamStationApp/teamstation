import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync
} from 'node:fs'
import { request } from 'node:https'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { asObject, asOptional, asString } from 'cleaners'

import { privateJson, type Upload } from './config'
import { rememberSecret, rememberSecrets } from './redact'
import { noSymlinks } from './state'
import { httpsOrigin, integer, object, text } from './validation'

const asTokenFile = object({
  schemaVersion: integer(1, 1),
  origin: httpsOrigin,
  token: text(4096),
  id: asOptional(text(256)),
  name: asOptional(text(256)),
  expiresAt: asOptional((value: unknown): number | null =>
    value === null ? null : integer()(value)
  )
})
export interface Package {
  file: string
  bundleId: string
  version: string
  buildNumber: string
  branch: string
  commit: string
  buildTime: string
  size: number
  digest: string
}
export async function fingerprint(
  file: string
): Promise<{ digest: string; size: number }> {
  noSymlinks(file)
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size === 0)
      throw new Error('Missing regular artifact')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file, { fd, autoClose: false }))
      hash.update(chunk)
    return { digest: hash.digest('hex'), size: stat.size }
  } finally {
    closeSync(fd)
  }
}
class Retryable extends Error {}
function connectionError(error: unknown, signal: AbortSignal): Error {
  const code =
    error instanceof Error && 'code' in error ? String(error.code) : ''
  if (signal.aborted) return new Error('Deployment cancelled')
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code))
    return new Error('Upload TLS verification failed')
  return new Retryable('Upload connection failed')
}
interface Reply {
  status: number
  body: unknown
}
async function send(
  url: URL,
  method: string,
  headers: Record<string, string>,
  data: AsyncIterable<Buffer> | undefined,
  signal: AbortSignal
): Promise<Reply> {
  signal.throwIfAborted()
  return await new Promise((resolve, reject) => {
    const req = request(url, { method, headers, signal }, res => {
      const parts: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1024 * 1024) {
          res.destroy()
          reject(new Error('Upload response too large'))
          return
        }
        parts.push(chunk)
      })
      res.on('error', () => {
        reject(new Retryable('Upload response interrupted'))
      })
      res.on('end', () => {
        try {
          const status = res.statusCode ?? 500
          const bytes = Buffer.concat(parts).toString()
          resolve({
            status,
            body: status >= 200 && status < 300 ? JSON.parse(bytes) : {}
          })
        } catch {
          reject(new Error('Invalid upload response'))
        }
      })
    })
    const timer = setTimeout(
      () => req.destroy(new Error('Upload timed out')),
      90 * 60000
    )
    req.setTimeout(60000, () => req.destroy(new Error('Upload stalled')))
    req.once('close', () => {
      clearTimeout(timer)
    })
    req.on('error', error => {
      reject(connectionError(error, signal))
    })
    if (data == null) req.end()
    else
      pipeline(Readable.from(data), req).catch((error: unknown) => {
        reject(connectionError(error, signal))
      })
  })
}
function release(reply: Reply, file: Package): number {
  const out = asObject({
    id: integer(1),
    bundle_id: asString,
    release_version: asString,
    build_version: asString,
    git_commit: asString
  })(reply.body)
  if (
    out.bundle_id !== file.bundleId ||
    out.release_version !== file.version ||
    out.build_version !== file.buildNumber ||
    out.git_commit !== file.commit
  )
    throw new Error('Server publication does not match this build')
  return out.id
}
export async function upload(
  config: Upload,
  file: Package,
  signal: AbortSignal,
  wait = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        clearTimeout(timer)
        reject(new Error('Deployment cancelled'))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, ms)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
): Promise<number> {
  // Existing Mason configurations may still name the former credential file.
  // A database-backed Mason secret takes precedence without recreating that file.
  const credentialEnv =
    config.credentialEnv ??
    (config.kind === 'mason' && process.env.MASON_UPLOAD_CREDENTIAL != null
      ? 'MASON_UPLOAD_CREDENTIAL'
      : undefined)
  const credential = (() => {
    if (credentialEnv == null) {
      if (config.tokenFile == null)
        throw new Error('Missing upload credential source')
      return privateJson(config.tokenFile, asTokenFile)
    }
    const encoded = process.env[credentialEnv]
    if (encoded == null || encoded === '')
      throw new Error('Missing upload credential secret')
    rememberSecret(encoded)
    try {
      const out = asTokenFile(JSON.parse(encoded))
      rememberSecrets(out)
      return out
    } catch {
      throw new Error('Invalid upload credential secret')
    }
  })()
  if (
    credential.origin !== config.origin ||
    (credential.expiresAt != null && credential.expiresAt <= Date.now())
  )
    throw new Error('Upload credential origin or expiry is invalid')
  const actual = await fingerprint(file.file)
  if (actual.digest !== file.digest || actual.size !== file.size)
    throw new Error('Artifact changed after verification')
  for (let attempt = 0; attempt < 4; attempt++) {
    signal.throwIfAborted()
    try {
      if (attempt > 0 && config.kind === 'zealot') {
        const query = new URL('/api/apps/version_exist', config.origin)
        query.search = new URLSearchParams({
          token: credential.token,
          channel_key: config.channelKey,
          bundle_id: file.bundleId,
          release_version: file.version,
          build_version: file.buildNumber,
          git_commit: file.commit
        }).toString()
        const found = await send(query, 'GET', {}, undefined, signal)
        if (found.status === 200) return release(found, file)
        if (found.status !== 404)
          throw new Error('Cannot safely resolve the previous upload outcome')
      }
      const boundary = 'deploy-' + randomBytes(24).toString('hex')
      const fields = {
        token: credential.token,
        channel_key: config.channelKey,
        branch: file.branch,
        git_commit: file.commit,
        source: 'deploy',
        custom_fields: JSON.stringify({
          mason: {
            bundleId: file.bundleId,
            version: file.version,
            buildNumber: file.buildNumber,
            buildTime: file.buildTime
          }
        })
      }
      async function* body(): AsyncGenerator<Buffer> {
        for (const [name, value] of Object.entries(fields))
          yield Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
          )
        const extension = file.file.split('.').pop()
        if (extension == null || !['ipa', 'apk', 'dmg'].includes(extension))
          throw new Error('Unsupported package extension')
        yield Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="package.${extension}"\r\nContent-Type: application/octet-stream\r\n\r\n`
        )
        noSymlinks(file.file)
        const hash = createHash('sha256')
        let size = 0
        const stream = createReadStream(file.file, {
          fd: openSync(file.file, constants.O_RDONLY | constants.O_NOFOLLOW),
          autoClose: true
        })
        for await (const chunk of stream) {
          hash.update(chunk)
          size += chunk.length
          yield Buffer.from(chunk)
        }
        if (hash.digest('hex') !== file.digest || size !== file.size)
          throw new Error('Artifact changed during upload')
        yield Buffer.from(`\r\n--${boundary}--\r\n`)
      }
      const response = await send(
        new URL('/api/apps/upload', config.origin),
        'POST',
        { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body(),
        signal
      )
      if (response.status === 201) return release(response, file)
      if (response.status === 429 || response.status >= 500)
        throw new Retryable('Upload temporarily unavailable')
      throw new Error('Upload rejected; check credentials, channel and package')
    } catch (error) {
      if (!(error instanceof Retryable) || attempt === 3 || signal.aborted)
        throw error
      await wait(500 * 2 ** attempt + Math.floor(Math.random() * 250))
    }
  }
  throw new Error('Upload failed')
}
