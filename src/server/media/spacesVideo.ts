import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { putObjectFile, SpaceRefusal } from './images'
import { presignGetUrl } from './presign'
import { spaceConfigured, spaceKey, type SpaceSettings } from './spacesHls'
import {
  isSecretKeyOf,
  oldVideoPrefix,
  uploadHeadersFor,
  withoutSecrets
} from './videoPrefix'

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
 * How many objects of one video go up, or are checked, at once.
 *
 * A segmented recording is a thousand or more ~3 MB objects, and one at a
 * time would turn a 3.5 GB take's few minutes into the better part of an
 * hour. Eight keeps a single upload far below the bucket's 800 operations a
 * second, shared with every player and every other upload.
 */
export const OBJECTS_IN_FLIGHT = 8

/** A transient failure is retried after these waits; then it is a failure. */
export const SPACE_RETRY_WAITS_MS = [500, 1000, 2000, 4000, 8000] as const

/** Network failures that a second try can get past. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
])

/** How long one verify request may take before it is tried again. */
export const VERIFY_TIMEOUT_MS = 60_000

/**
 * Whether a failure talking to the Space is worth another try: the bucket
 * asking for less (`503 Slow Down`, `429`), another 5xx, a connection reset
 * or refused, a name or route that did not resolve, or a request that timed
 * out or went quiet. A refusal of the request itself (403, 404, a short
 * object) is not, and neither is a caller cancelling on purpose (`AbortError`):
 * only a timeout (`TimeoutError`) is the Space's doing.
 */
export function isTransientSpaceError(error: unknown): boolean {
  if (error instanceof SpaceRefusal)
    return error.status >= 500 || error.status === 429
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError') return true
  if (error.message === 'The Space stopped answering') return true
  const code = (error as { code?: unknown }).code
  const cause = (error as { cause?: { code?: unknown } }).cause?.code
  return (
    (typeof code === 'string' && TRANSIENT_CODES.has(code)) ||
    (typeof cause === 'string' && TRANSIENT_CODES.has(cause))
  )
}

/**
 * Runs `work`, and runs it again after each of `SPACE_RETRY_WAITS_MS` while it
 * fails in a way another try can get past (`isTransientSpaceError`). A
 * recording is a thousand objects or more, so one reset or one `503 Slow
 * Down` must not cost the whole upload.
 */
export async function withSpaceRetry<T>(
  work: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<T> {
  for (const waitMs of SPACE_RETRY_WAITS_MS) {
    try {
      return await work()
    } catch (error) {
      if (!isTransientSpaceError(error)) throw error
      await sleep(waitMs)
    }
  }
  return await work()
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * `work` over every item, at most `limit` at once, in order of starting.
 *
 * The first failure stops anything new from starting, waits for what is
 * already running, and is then thrown, so nothing is still writing to the
 * Space when the caller goes on to clean up after it.
 */
export async function eachInFlight<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  let failed = false
  let failure: unknown
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const item = items[next++]
        try {
          await work(item)
        } catch (error) {
          if (!failed) failure = error
          failed = true
        }
      }
    })
  )
  if (failed) throw failure
}

/**
 * Media first, then the playlists, so no playlist is in the Space before
 * every object it lists. Each part in name order.
 */
function playlistsLast(names: readonly string[]): {
  media: string[]
  playlists: string[]
} {
  const sorted = [...names].sort()
  return {
    media: sorted.filter(name => !name.endsWith('.m3u8')),
    playlists: sorted.filter(name => name.endsWith('.m3u8'))
  }
}

/**
 * Uploads every file of a finished video.
 *
 * `OBJECTS_IN_FLIGHT` at a time, `init*.mp4` and the segments before the
 * playlists that list them. Nothing is served from the Space until the whole
 * set is verified, but a playlist that only appears once its pieces are there
 * is never wrong, whoever looks.
 */
export async function uploadVideoDirectory(options: {
  space: SpaceSettings
  videoId: string
  /** Under `videos/<id>-<secret>/`, public where its kind is; null for `videos/<id>/`. */
  spaceSecret: string | null
  dir: string
  /**
   * Which files. Given by name because the directory holds more than the
   * recording while anybody is still watching the stream it came from, and
   * uploading two thousand segments beside the file that replaced them would
   * be paying twice for one game.
   */
  files?: string[]
}): Promise<UploadedVideo> {
  const { space, dir } = options
  const video = { id: options.videoId, spaceSecret: options.spaceSecret }
  if (!spaceConfigured(space)) throw new Error('No Space is configured')

  const names = (
    options.files ?? (await readdir(dir)).filter(name => !name.startsWith('.'))
  ).sort()
  let bytes = 0
  const put = async (name: string): Promise<void> => {
    const path = join(dir, name)
    const info = await stat(path)
    if (!info.isFile()) return
    await withSpaceRetry(async () => {
      await putObjectFile({
        space,
        key: spaceKey(video, name),
        path,
        contentType: contentTypeFor(name),
        ...uploadHeadersFor(video.spaceSecret, name)
      })
    })
    bytes += info.size
  }
  const { media, playlists } = playlistsLast(names)
  await eachInFlight(media, OBJECTS_IN_FLIGHT, put)
  await eachInFlight(playlists, OBJECTS_IN_FLIGHT, put)
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
  spaceSecret: string | null
  dir: string
  files: string[]
  expiresSec?: number
  fetch?: typeof fetch
  /** For a test: how the retries wait. */
  sleep?: (ms: number) => Promise<void>
}): Promise<VerifyResult> {
  const { space, dir, files } = options
  const video = { id: options.videoId, spaceSecret: options.spaceSecret }
  const baseFetch = options.fetch ?? globalThis.fetch
  // A request that stalls or meets a `503 Slow Down` throws, so that the
  // check it belongs to is tried again below.
  const doFetch = (async (url: string, init?: RequestInit) => {
    const response = await baseFetch(url, {
      ...init,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    })
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel()
      throw new SpaceRefusal(
        withoutSecrets(`${url.split('?')[0]} answered ${response.status}`),
        response.status
      )
    }
    return response
  }) as typeof fetch
  const expiresSec = options.expiresSec ?? 300

  let checked = 0
  let mismatch: VerifyResult | undefined
  const check = async (name: string): Promise<void> => {
    if (mismatch != null) return
    // A thousand checks at eight a time meet the same `503 Slow Down` and the
    // same resets the upload does, and a check that fails for want of a retry
    // throws away an upload that arrived whole. Each try signs its URL again:
    // six of them can outlast one signature. What still fails after the
    // retries is a real answer, and comes back as one.
    const result = await withSpaceRetry(
      async () => await checkOne(name),
      options.sleep
    ).catch((error: unknown): VerifyResult => ({
      ok: false,
      reason: withoutSecrets(
        `${name}: ${error instanceof Error ? error.message : String(error)}`
      )
    }))
    if (result == null) return
    if (!result.ok) mismatch ??= result
    else checked += 1
  }
  const checkOne = async (name: string): Promise<VerifyResult | undefined> => {
    const path = join(dir, name)
    // A name that is not a file here is not a file to check there either:
    // the upload only ever put files in.
    const local = await stat(path).catch(() => undefined)
    if (local?.isFile() !== true) return undefined

    const url = presignGetUrl({
      ...space,
      key: spaceKey(video, name),
      expiresSec
    })

    // The playlists are read whole and hashed: they are a few kilobytes, and
    // every other file in the bucket is only reachable through them.
    if (name.endsWith('.m3u8')) {
      const response = await doFetch(url)
      if (!response.ok) {
        await response.body?.cancel()
        return { ok: false, reason: `${name} answered ${response.status}` }
      }
      const remote = Buffer.from(await response.arrayBuffer())
      const here = await readFile(path)
      if (sha256(remote) !== sha256(here)) {
        return { ok: false, reason: `${name} came back different` }
      }
      return { ok: true, checked: 1 }
    }

    return await verifyObjectLength({
      space,
      key: spaceKey(video, name),
      size: local.size,
      expiresSec,
      fetch: doFetch
    })
  }

  // The same order as the upload, and the first mismatch stops the rest.
  const { media, playlists } = playlistsLast(files)
  await eachInFlight(media, OBJECTS_IN_FLIGHT, check)
  await eachInFlight(playlists, OBJECTS_IN_FLIGHT, check)
  if (mismatch != null) return mismatch
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
      return {
        ok: false,
        reason: withoutSecrets(`${key} answered ${response.status}`)
      }
    const length = lengthFromContentRange(
      response.headers.get('content-range') ?? ''
    )
    if (response.status !== 206 || length == null)
      return {
        ok: false,
        reason: withoutSecrets(`${key} did not answer a byte range`)
      }
    if (length !== size)
      return {
        ok: false,
        reason: withoutSecrets(
          `${key} is ${length} bytes there and ${size} here`
        )
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
  prefix: string,
  options: ListOptions = {}
): Promise<string[]> {
  return (await listSpaceObjectEntries(space, prefix, options)).map(
    entry => entry.key
  )
}

/** A listing whose every page must answer within `timeoutMs`, when given. */
export interface ListOptions {
  timeoutMs?: number
}

export interface SpaceObjectEntry {
  key: string
  size: number
  etag: string
}

/** List metadata lets a restarted publisher recognize unchanged single PUTs. */
export async function listSpaceObjectEntries(
  space: SpaceSettings,
  prefix: string,
  { timeoutMs }: ListOptions = {}
): Promise<SpaceObjectEntry[]> {
  const entries: SpaceObjectEntry[] = []
  let token: string | undefined
  const seen = new Set<string>()
  for (let page = 0; page < 50; page++) {
    const query: Record<string, string> = { 'list-type': '2', prefix }
    if (token != null) query['continuation-token'] = token
    const response = await fetch(
      signed(space, { method: 'GET', key: '', query }),
      timeoutMs == null ? {} : { signal: AbortSignal.timeout(timeoutMs) }
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        withoutSecrets(`Listing ${prefix} answered ${response.status}`)
      )
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
 * Every key under any secret prefix of this video, `videos/<id>-<32 hex>/`,
 * found by listing `videos/<id>-` and keeping only that exact segment: another
 * video's id can start with this one's and a dash.
 */
export async function secretKeysOf(
  space: SpaceSettings,
  videoId: string
): Promise<string[]> {
  return (await listSpaceObjects(space, `videos/${videoId}-`)).filter(key =>
    isSecretKeyOf(videoId, key)
  )
}

/**
 * Removes everything the Space holds for one video: its secret prefix
 * `videos/<id>-<secret>/` and its old one `videos/<id>/`, which holds its
 * stills (and, before the move, its media). The trailing slash keeps the
 * second from matching the first.
 *
 * Every secret prefix of the video goes, whatever its row says:
 * `videos/<id>-` is listed and only keys whose second segment is exactly
 * `<id>-` and 32 hex characters are taken, since another video's id can start
 * with this one's. A video can have more than its row's: `segmentSpaceVideos`
 * leaves the old one until `--delete-old`, a run of it that stopped leaves a
 * partial one, and a move that copied its objects and stopped before storing
 * the secret left public copies. Nothing else would ever find those once the
 * row is gone.
 *
 * `spaceSecret` is the row's, kept in the signature for the callers that
 * have it; null or undefined when there is none.
 *
 * Individual signed deletes with bounded concurrency avoid a separate signed
 * batch-payload implementation while keeping large fragment sets practical.
 */
export async function deleteVideoFromSpace(options: {
  space: SpaceSettings
  videoId: string
  spaceSecret: string | null | undefined
}): Promise<{ deleted: number }> {
  const { space, videoId } = options
  const secretKeys = await secretKeysOf(space, videoId)
  const fromSecret = await deleteSpaceKeys(space, secretKeys)
  const fromOld = await deleteSpacePrefix(space, oldVideoPrefix(videoId))
  return { deleted: fromSecret.deleted + fromOld.deleted }
}

/** Removes a prefix with at most 32 requests in flight, draining before failure. */
export async function deleteSpacePrefix(
  space: SpaceSettings,
  prefix: string
): Promise<{ deleted: number }> {
  return await deleteSpaceKeys(space, await listSpaceObjects(space, prefix))
}

/** Removes these keys with at most 32 requests in flight, draining before failure. */
export async function deleteSpaceKeys(
  space: SpaceSettings,
  keys: readonly string[]
): Promise<{ deleted: number }> {
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
            throw new Error(
              withoutSecrets(`Deleting ${key} answered ${response.status}`)
            )
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
