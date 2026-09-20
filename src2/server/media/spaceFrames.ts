import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MEDIA_PLAYLIST, VIDEO_FILE } from './ffmpeg'
import { presignGetUrl } from './presign'
import type { SpaceSettings } from './spacesHls'
import { PlaylistCache, spaceKey } from './spacesHls'

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
 * The media playlist is the index the file lacks. It lists every fragment with
 * its duration and its byte range, which is enough to say exactly which
 * megabyte of a 2.3 GB object holds a given second. So the frame is cut from
 * that one fragment, with the init segment in front of it — about a megabyte
 * and a second, rather than the whole file and no end in sight.
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
  init: ByteRange
  /** The fragment's own bytes. */
  segment: ByteRange
}

/**
 * The fragment holding a given second, from a byte-range media playlist.
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
  let init: ByteRange | undefined
  let startSec = 0
  let duration: number | undefined
  let range: ByteRange | undefined
  let nextOffset = 0

  for (const line of playlist.split('\n')) {
    const text = line.trim()
    if (text.startsWith('#EXT-X-MAP:')) {
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
    if (init == null || duration == null || range == null) return undefined
    nextOffset = range.offset + range.length
    if (atSec < startSec + duration) {
      return { startSec, init, segment: range }
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
  /** Swapped out in tests. */
  fetch?: typeof fetch
}

/**
 * How long a presigned URL for a fragment is good for.
 *
 * Two range requests follow it immediately and nothing keeps it, so this only
 * has to outlast a slow pair of round trips.
 */
const FRAGMENT_URL_TTL_SEC = 300

/**
 * VOD playlists never change, and one is read for every still of the same
 * game. Per worker, like the one the playback route keeps, and for the same
 * reason: the cost of a miss is a single small GET.
 */
const playlists = new Map<string, PlaylistCache>()

function playlistsFor(
  space: SpaceSettings,
  doFetch?: typeof fetch
): PlaylistCache {
  const held = playlists.get(space.bucket)
  if (held != null) return held
  const made = new PlaylistCache({
    space,
    expiresSec: FRAGMENT_URL_TTL_SEC,
    fetch: doFetch
  })
  playlists.set(space.bucket, made)
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

  const playlist = await playlistsFor(space, options.fetch).get(
    videoId,
    MEDIA_PLAYLIST
  )
  if (playlist == null) return undefined
  const fragment = fragmentAt(playlist, atSec)
  if (fragment == null) return undefined

  const url = presignGetUrl({
    ...space,
    key: spaceKey(videoId, VIDEO_FILE),
    expiresSec: FRAGMENT_URL_TTL_SEC
  })

  // The init segment and the fragment, in that order: a fragment on its own
  // has no codec description and FFmpeg cannot open it.
  const parts = await Promise.all(
    [fragment.init, fragment.segment].map(
      async range => await range_(doFetch, url, range)
    )
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
  if (response.status !== 206) return undefined
  return new Uint8Array(await response.arrayBuffer())
}
