import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { putObjectFile } from './images'
import { presignGetUrl } from './presign'
import { spaceConfigured, spaceKey, type SpaceSettings } from './spacesHls'

/**
 * Putting a finished recording in the Space, and proving it arrived.
 *
 * The local copy is deleted afterwards, so "it uploaded" is not a thing to
 * take on trust. Every file is checked for length, and the playlists —
 * small, and the part that makes the rest reachable — are checked byte for
 * byte. A length check costs one ranged request per file, which is the
 * cheapest question that still has a real answer.
 */

/** What a player must be told each file is, or it will refuse to play it. */
export function contentTypeFor(file: string): string {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl'
  if (file.endsWith('.m4s')) return 'video/iso.segment'
  if (file.endsWith('.mp4')) return 'video/mp4'
  return 'application/octet-stream'
}

export interface UploadedVideo {
  files: string[]
  bytes: number
}

/**
 * Uploads every file of a finished video.
 *
 * In name order, which puts `init.mp4` and the playlists before the segments
 * — it does not matter for correctness, since nothing is served from the
 * Space until the whole thing is verified, but a half-finished upload that
 * somebody looks at reads better this way.
 */
export async function uploadVideoDirectory(options: {
  space: SpaceSettings
  videoId: string
  dir: string
  /**
   * Which files. Given by name because the directory holds more than the
   * recording while anybody is still watching the stream it came from, and
   * uploading two thousand segments beside the file that replaced them would
   * be paying twice for one game.
   */
  files?: string[]
}): Promise<UploadedVideo> {
  const { space, videoId, dir } = options
  if (!spaceConfigured(space)) throw new Error('No Space is configured')

  const names = (
    options.files ?? (await readdir(dir)).filter(name => !name.startsWith('.'))
  ).sort()
  let bytes = 0
  for (const name of names) {
    const path = join(dir, name)
    const info = await stat(path)
    if (!info.isFile()) continue
    await putObjectFile({
      space,
      key: spaceKey(videoId, name),
      path,
      contentType: contentTypeFor(name)
    })
    bytes += info.size
  }
  return { files: names, bytes }
}

export type VerifyResult =
  { ok: true; checked: number } | { ok: false; reason: string }

/**
 * Asks the Space what it has, and compares.
 *
 * A ranged GET of one byte answers with `content-range: bytes 0-0/<length>`,
 * which is existence and length in a single cheap request — and it is the same
 * request a player makes, so a bucket that is misconfigured for ranges fails
 * here rather than in front of somebody watching a game.
 */
export async function verifyVideoDirectory(options: {
  space: SpaceSettings
  videoId: string
  dir: string
  files: string[]
  expiresSec?: number
  fetch?: typeof fetch
}): Promise<VerifyResult> {
  const { space, videoId, dir, files } = options
  const doFetch = options.fetch ?? globalThis.fetch
  const expiresSec = options.expiresSec ?? 300

  let checked = 0
  for (const name of files) {
    const path = join(dir, name)
    // A name that is not a file here is not a file to check there either:
    // the upload only ever put files in.
    const local = await stat(path).catch(() => undefined)
    if (local?.isFile() !== true) continue

    const url = presignGetUrl({
      ...space,
      key: spaceKey(videoId, name),
      expiresSec
    })

    // The playlists are read whole and hashed: they are a few kilobytes, and
    // every other file in the bucket is only reachable through them.
    if (name.endsWith('.m3u8')) {
      const response = await doFetch(url)
      if (!response.ok) {
        return { ok: false, reason: `${name} answered ${response.status}` }
      }
      const remote = Buffer.from(await response.arrayBuffer())
      const here = await readFile(path)
      if (sha256(remote) !== sha256(here)) {
        return { ok: false, reason: `${name} came back different` }
      }
      checked += 1
      continue
    }

    const result = await verifyObjectLength({
      space,
      key: spaceKey(videoId, name),
      size: local.size,
      expiresSec,
      fetch: doFetch
    })
    if (!result.ok) return result
    checked += 1
  }

  if (checked === 0) return { ok: false, reason: 'nothing to verify' }
  return { ok: true, checked }
}

/** Confirms an object with one byte, and releases even a misbehaving response. */
export async function verifyObjectLength(options: {
  space: SpaceSettings
  key: string
  size: number
  expiresSec?: number
  fetch?: typeof fetch
}): Promise<VerifyResult> {
  const { space, key, size, expiresSec = 300 } = options
  const response = await (options.fetch ?? globalThis.fetch)(
    presignGetUrl({ ...space, key, expiresSec }),
    { headers: { range: 'bytes=0-0' } }
  )
  try {
    if (!response.ok)
      return { ok: false, reason: `${key} answered ${response.status}` }
    const length = lengthFromContentRange(
      response.headers.get('content-range') ?? ''
    )
    if (response.status !== 206 || length == null)
      return { ok: false, reason: `${key} did not answer a byte range` }
    if (length !== size)
      return {
        ok: false,
        reason: `${key} is ${length} bytes there and ${size} here`
      }
    return { ok: true, checked: 1 }
  } finally {
    await response.body?.cancel()
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `bytes 0-0/12345` → 12345. */
export function lengthFromContentRange(header: string): number | undefined {
  const match = /^bytes \d+-\d+\/(\d+)$/.exec(header.trim())
  if (match == null) return undefined
  const length = Number.parseInt(match[1], 10)
  return Number.isFinite(length) ? length : undefined
}

/**
 * Taking a video off the Space.
 *
 * Nothing removed a finished video before: deleting one in TeamStation left
 * every byte of it in the bucket, being paid for, for ever. The list is asked
 * for rather than guessed at — a live recording leaves a single-file MP4 and a
 * byte-range playlist, a converted one leaves a directory of segments, and a
 * guessed set of names would quietly leave whichever it did not guess.
 */
function signed(
  space: SpaceSettings,
  options: {
    method: 'GET' | 'DELETE'
    key: string
    query?: Record<string, string>
  }
): string {
  if (!spaceConfigured(space)) throw new Error('No Space is configured')
  return presignGetUrl({
    method: options.method,
    endpoint: space.endpoint,
    region: space.region,
    bucket: space.bucket,
    accessKeyId: space.accessKeyId,
    secretAccessKey: space.secretAccessKey,
    key: options.key,
    query: options.query,
    expiresSec: 300,
    pathStyle: space.pathStyle
  })
}

/** Every key under a prefix, following the continuation token to the end. */
export async function listSpaceObjects(
  space: SpaceSettings,
  prefix: string
): Promise<string[]> {
  return (await listSpaceObjectEntries(space, prefix)).map(entry => entry.key)
}

export interface SpaceObjectEntry {
  key: string
  size: number
  etag: string
}

/** List metadata lets a restarted publisher recognize unchanged single PUTs. */
export async function listSpaceObjectEntries(
  space: SpaceSettings,
  prefix: string
): Promise<SpaceObjectEntry[]> {
  const entries: SpaceObjectEntry[] = []
  let token: string | undefined
  const seen = new Set<string>()
  for (let page = 0; page < 50; page++) {
    const query: Record<string, string> = { 'list-type': '2', prefix }
    if (token != null) query['continuation-token'] = token
    const response = await fetch(
      signed(space, { method: 'GET', key: '', query })
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Listing ${prefix} answered ${response.status}`)
    }
    const xml = await response.text()
    if (
      !/<ListBucketResult(?:\s[^>]*)?>[\s\S]*<\/ListBucketResult>/.test(xml) ||
      !/<IsTruncated>(?:true|false)<\/IsTruncated>/.test(xml)
    )
      throw new Error('Invalid object listing')
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]+)<\/Key>/.exec(match[1])?.[1]
      const size = /<Size>(\d+)<\/Size>/.exec(match[1])?.[1]
      const etag = /<ETag>([^<]*)<\/ETag>/.exec(match[1])?.[1]
      if (key == null || size == null || etag == null)
        throw new Error('Incomplete object listing')
      const decoded = decodeXml(key)
      if (!decoded.startsWith(prefix))
        throw new Error('Object listing escaped its prefix')
      entries.push({
        key: decoded,
        size: Number(size),
        etag: decodeXml(etag).replace(/^"|"$/g, '')
      })
    }
    if (!xml.includes('<IsTruncated>true</IsTruncated>')) return entries
    const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(
      xml
    )?.[1]
    if (next == null || seen.has(next))
      throw new Error('Incomplete object listing continuation')
    seen.add(next)
    token = decodeXml(next)
  }
  throw new Error('Object listing exceeded fifty pages')
}

/** The five entities an S3 listing escapes, and nothing else. */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Removes everything the Space holds for one video.
 *
 * Individual signed deletes with bounded concurrency avoid a separate signed
 * batch-payload implementation while keeping large fragment sets practical.
 */
export async function deleteVideoFromSpace(options: {
  space: SpaceSettings
  videoId: string
}): Promise<{ deleted: number }> {
  return await deleteSpacePrefix(options.space, `videos/${options.videoId}/`)
}

/** Removes a prefix with at most 32 requests in flight, draining before failure. */
export async function deleteSpacePrefix(
  space: SpaceSettings,
  prefix: string
): Promise<{ deleted: number }> {
  const keys = await listSpaceObjects(space, prefix)
  let deleted = 0
  let next = 0
  let failure: unknown
  let failed = false
  await Promise.all(
    Array.from({ length: Math.min(32, keys.length) }, async () => {
      while (!failed && next < keys.length) {
        const key = keys[next++]
        try {
          const response = await fetch(
            signed(space, { method: 'DELETE', key }),
            { method: 'DELETE' }
          )
          await response.body?.cancel()
          if (!response.ok && response.status !== 404)
            throw new Error(`Deleting ${key} answered ${response.status}`)
          deleted++
        } catch (error) {
          if (!failed) failure = error
          failed = true
        }
      }
    })
  )
  if (failed) throw failure
  return { deleted }
}
