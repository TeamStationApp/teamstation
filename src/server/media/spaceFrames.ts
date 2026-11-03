import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { MASTER_PLAYLIST, MEDIA_PLAYLIST } from './ffmpeg'
import { presignGetUrl } from './presign'
import type { SpaceSettings } from './spacesHls'
import { mediaVariant, spaceKey, SpacePlayback } from './spacesHls'
import { readPart } from './wallClockScan'

/**
 * Reading one frame out of a video that lives in the Space.
 *
 * FFmpeg opens an HTTPS URL and seeks it with range requests, so the obvious
 * thing is to hand it the presigned `video.mp4` and let it get on with it.
 * That does not work here. The remux writes a fragmented MP4, which carries no
 * index of its own, so seeking one means walking the fragments from the front:
 * asking for the frame an hour into a two-hour game read 1.2 GB and had not
 * produced a picture two minutes later.
 *
 * The media playlist identifies the fragment holding a given second. Uploaded
 * recordings use byte ranges of one file; live recordings use one object per
 * fragment. Both are read with their init segment and sought relative to the
 * selected fragment, without downloading the whole recording.
 */

export interface ByteRange {
  length: number
  offset: number
}

/** One fragment of the video, as the media playlist describes it. */
export interface FrameFragment {
  /** Where the fragment starts, in seconds from the start of the video. */
  startSec: number
  /** The init segment, which every fragment needs in front of it. */
  init?: ByteRange
  /** The fragment's own bytes. */
  segment?: ByteRange
  initFile: string
  segmentFile: string
}

/**
 * The fragment holding a given second, from either recording playlist shape.
 *
 * `#EXT-X-BYTERANGE` may leave its offset out, which HLS defines as carrying
 * on from the end of the previous range. Our own remux always writes one, but
 * a playlist is read here rather than trusted, and the omitted form costs two
 * lines to support.
 */
export function fragmentAt(
  playlist: string,
  atSec: number
): FrameFragment | undefined {
  if (!Number.isFinite(atSec) || atSec < 0) return undefined
  let init: ByteRange | undefined
  let initFile: string | undefined
  let startSec = 0
  let duration: number | undefined
  let range: ByteRange | undefined
  let nextOffset = 0

  for (const line of playlist.split('\n')) {
    const text = line.trim()
    if (text.startsWith('#EXT-X-MAP:')) {
      initFile = /URI="([^"]+)"/.exec(text)?.[1]
      init = undefined
      const found = /BYTERANGE="(\d+)@(\d+)"/.exec(text)
      if (found != null) {
        init = { length: Number(found[1]), offset: Number(found[2]) }
        // The map is a range of the same object, so a segment that leaves its
        // own offset out carries on from the end of this one.
        nextOffset = init.offset + init.length
      }
      continue
    }
    if (text.startsWith('#EXTINF:')) {
      duration = Number(text.slice('#EXTINF:'.length).replace(/,.*$/, ''))
      continue
    }
    if (text.startsWith('#EXT-X-BYTERANGE:')) {
      const [length, offset] = text.slice('#EXT-X-BYTERANGE:'.length).split('@')
      range = {
        length: Number(length),
        offset: offset == null ? nextOffset : Number(offset)
      }
      continue
    }
    if (text === '' || text.startsWith('#')) continue

    // A media segment's URI, which ends the entry the tags above described.
    if (
      initFile == null ||
      duration == null ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      return undefined
    if (
      !/^(?:init(?:\d{6,})?|video)\.mp4$/.test(initFile) ||
      !/^(?:video\.mp4|seg\d{6,}\.m4s)$/.test(text)
    )
      return undefined
    if (
      (initFile === 'video.mp4' && init == null) ||
      (text === 'video.mp4' && range == null)
    )
      return undefined
    if (range != null) nextOffset = range.offset + range.length
    if (atSec < startSec + duration) {
      return { startSec, init, segment: range, initFile, segmentFile: text }
    }
    startSec += duration
    duration = undefined
    range = undefined
  }
  return undefined
}

/** A fragment on disk, ready for FFmpeg, and the way to be rid of it. */
export interface SpaceFrame {
  /** The file to read: the init segment followed by one fragment. */
  path: string
  /** What to pass to `-ss`: the moment's offset within that fragment. */
  seekSec: number
  /** Removes the file. Called whether or not a frame came out of it. */
  release: () => Promise<void>
}

export interface SpaceFrameOptions {
  space: SpaceSettings
  videoId: string
  /** Seconds into the video. */
  atSec: number
  /** The work directory the fragment is written under. */
  workDir: string
  /** Only a verified final live playlist may be cached indefinitely. */
  verified?: boolean
  /** Swapped out in tests. */
  fetch?: typeof fetch
}

/**
 * How long a presigned URL for a fragment is good for.
 *
 * Two object or range requests follow it immediately and nothing keeps it, so this only
 * has to outlast a slow pair of round trips.
 */
const FRAGMENT_URL_TTL_SEC = 300

/**
 * Share the playback route's cache policy: permanent recording playlists,
 * and one-second refreshes for live playlists not yet verified as final.
 */
const playlists = new Map<string, SpacePlayback>()

function playlistsFor(
  space: SpaceSettings,
  doFetch?: typeof fetch
): SpacePlayback {
  const key = JSON.stringify(space)
  const held = playlists.get(key)
  if (held != null) return held
  const made = new SpacePlayback({
    space,
    expiresSec: FRAGMENT_URL_TTL_SEC,
    fetch: doFetch
  })
  playlists.set(key, made)
  return made
}

/** Forgets every cached playlist. For tests. */
export function clearFragmentCache(): void {
  playlists.clear()
}

/**
 * Fetches the one fragment holding a moment, and writes it where FFmpeg can
 * read it. `undefined` if the playlist is not in the Space or does not reach
 * that far, which a caller reports as a missing thumbnail.
 */
export async function fetchSpaceFrame(
  options: SpaceFrameOptions
): Promise<SpaceFrame | undefined> {
  const { space, videoId, atSec, workDir } = options
  const doFetch = options.fetch ?? globalThis.fetch

  const cache = playlistsFor(space, options.fetch)
  const master = await cache.get(videoId, MASTER_PLAYLIST, true)
  const variant = master == null ? undefined : mediaVariant(master)
  if (variant == null) return undefined
  const playlist = await cache.get(videoId, variant, options.verified === true)
  if (playlist == null) return undefined
  const fragment = fragmentAt(playlist, atSec)
  if (fragment == null) return undefined

  // The init segment and the fragment, in that order: a fragment on its own
  // has no codec description and FFmpeg cannot open it.
  const objects: Array<[string, ByteRange | undefined]> = [
    [fragment.initFile, fragment.init],
    [fragment.segmentFile, fragment.segment]
  ]
  const parts = await Promise.all(
    objects.map(async ([file, range]) => {
      const url = presignGetUrl({
        ...space,
        key: spaceKey(videoId, file),
        expiresSec: FRAGMENT_URL_TTL_SEC
      })
      if (range != null) return await range_(doFetch, url, range)
      const response = await doFetch(url)
      if (!response.ok) {
        await response.body?.cancel()
        return undefined
      }
      return new Uint8Array(await response.arrayBuffer())
    })
  )
  if (parts.some(part => part == null)) return undefined

  const dir = join(workDir, 'frames')
  await mkdir(dir, { recursive: true })
  // A name of its own per request: two stills of the same video are cut at the
  // same time, and the second must not read a file the first is deleting.
  const path = join(dir, `${videoId}-${randomUUID()}.mp4`)
  await writeFile(path, Buffer.concat(parts as Uint8Array[]))

  return {
    path,
    seekSec: Math.max(0, atSec - fragment.startSec),
    release: async () => {
      await rm(path, { force: true })
    }
  }
}

/**
 * The same, for a recording on this machine whose playlist changes init
 * segment part way. No FFmpeg demuxer follows such a change, in a playlist or
 * in the one file a remux leaves, so a moment past the first is read as a
 * fragment is from the Space: its own init segment, then its own bytes.
 *
 * `path` is the playlist, or the file beside the playlist that lists it.
 * Undefined for anything else, which is read where it lies.
 */
export async function readLocalFrame(
  path: string,
  atSec: number,
  workDir: string
): Promise<SpaceFrame | undefined> {
  const playlistPath = path.endsWith('.m3u8')
    ? path
    : join(dirname(path), MEDIA_PLAYLIST)
  const playlist = await readFile(playlistPath, 'utf8').catch(() => undefined)
  if (playlist == null || !changesInit(playlist)) return undefined
  const fragment = fragmentAt(playlist, atSec)
  if (fragment == null) return undefined
  const dir = dirname(playlistPath)
  const framePath = join(workDir, `${randomUUID()}.mp4`)
  await writeFile(
    framePath,
    Buffer.concat([
      await readPart(join(dir, fragment.initFile), fragment.init),
      await readPart(join(dir, fragment.segmentFile), fragment.segment)
    ])
  )
  return {
    path: framePath,
    seekSec: Math.max(0, atSec - fragment.startSec),
    release: async () => {
      await rm(framePath, { force: true })
    }
  }
}

/** Whether a playlist names more than one init segment. */
function changesInit(playlist: string): boolean {
  return playlist.split('#EXT-X-MAP:').length > 2
}

async function range_(
  doFetch: typeof fetch,
  url: string,
  range: ByteRange
): Promise<Uint8Array | undefined> {
  const end = range.offset + range.length - 1
  const response = await doFetch(url, {
    headers: { range: `bytes=${range.offset}-${end}` }
  })
  // 206 is the only right answer: a 200 means the Space ignored the range and
  // is about to hand over the whole object, which is the thing being avoided.
  if (response.status !== 206) {
    await response.body?.cancel()
    return undefined
  }
  return new Uint8Array(await response.arrayBuffer())
}
