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

    const response = await doFetch(url, { headers: { range: 'bytes=0-0' } })
    if (!response.ok) {
      return { ok: false, reason: `${name} answered ${response.status}` }
    }
    const length = lengthFromContentRange(
      response.headers.get('content-range') ?? ''
    )
    if (length == null) {
      return { ok: false, reason: `${name} did not answer a byte range` }
    }
    if (length !== local.size) {
      return {
        ok: false,
        reason: `${name} is ${length} bytes there and ${local.size} here`
      }
    }
    checked += 1
  }

  if (checked === 0) return { ok: false, reason: 'nothing to verify' }
  return { ok: true, checked }
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
 * Nothing removed a finished video before: deleting one in GameStation left
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
  const keys: string[] = []
  let token: string | undefined
  // A bounded loop: a thousand keys per page, and a video that somehow has
  // more than fifty thousand parts is a bug rather than a video.
  for (let page = 0; page < 50; page += 1) {
    const query: Record<string, string> = { 'list-type': '2', prefix }
    if (token != null) query['continuation-token'] = token
    const response = await fetch(
      signed(space, { method: 'GET', key: '', query })
    )
    if (!response.ok) {
      throw new Error(`Listing ${prefix} answered ${response.status}`)
    }
    const xml = await response.text()
    for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      if (match[1] != null) keys.push(decodeXml(match[1]))
    }
    const truncated = xml.includes('<IsTruncated>true</IsTruncated>')
    if (!truncated) break
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(
      xml
    )?.[1]
    if (token == null) break
    token = decodeXml(token)
  }
  return keys
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
 * One key at a time rather than the batch delete, which needs a signed body
 * and an MD5 of it; a finished game is a handful of objects, and the batch
 * form would be the only place in this project that signs a payload.
 */
export async function deleteVideoFromSpace(options: {
  space: SpaceSettings
  videoId: string
}): Promise<{ deleted: number }> {
  const { space, videoId } = options
  const keys = await listSpaceObjects(space, `videos/${videoId}/`)
  let deleted = 0
  for (const key of keys) {
    const response = await fetch(signed(space, { method: 'DELETE', key }), {
      method: 'DELETE'
    })
    // 204 is the success; 404 means somebody else got there first, which is
    // the same outcome and not worth failing a delete over.
    if (!response.ok && response.status !== 404) {
      throw new Error(`Deleting ${key} answered ${response.status}`)
    }
    deleted += 1
  }
  return { deleted }
}
