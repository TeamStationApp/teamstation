import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { putObject } from './images'
import type { MediaContext } from './mediaContext'
import { signQueryToken } from './mediaTokens'
import { presignGetUrl } from './presign'
import { fetchSpaceFrame } from './spaceFrames'
import { spaceConfigured, spaceKey, type SpaceSettings } from './spacesHls'

const run = promisify(execFile)

/**
 * One frame of a video, as a small JPEG, kept in the Space.
 *
 * A still lives beside its video as `videos/<id>/stills/<second>.jpg`, and
 * nowhere else: the app server keeps nothing, so any number of them can answer
 * and any one can be replaced. A still is cut the first time it is wanted —
 * one frame, from the few byte ranges around the moment — and uploaded; every
 * request after that is a redirect to the Space. The frame is cut in a
 * temporary directory that is gone before the request is answered.
 *
 * Deleting a video from the Space takes its stills with it, since they share
 * its prefix.
 */

export type FrameSource =
  | { kind: 'file'; path: string }
  | { kind: 'space'; space: SpaceSettings; videoId: string }

export interface StillOptions {
  ffmpegPath: string
  /** Where the frame is read from. */
  source: FrameSource
  /** Where the still is kept. */
  space: SpaceSettings
  videoId: string
  /** Seconds into the video. */
  atSec: number
  /** Widest edge, in pixels. */
  width?: number
}

/** Whole seconds: a still a frame apart from another is the same picture. */
export function stillSecond(atSec: number): number {
  return Math.max(0, Math.round(atSec))
}

/** Where a video's still for this moment is kept in the Space. */
export function stillKey(videoId: string, atSec: number): string {
  return spaceKey(videoId, `stills/${stillSecond(atSec)}.jpg`)
}

/** What a still URL's token is signed against: this video's stills only. */
export function stillSubject(videoId: string): string {
  return `stills:${videoId}`
}

/**
 * The URL a list hands out for a still. The API answers it with a redirect
 * to the Space, cutting the still first if the Space does not have it yet.
 * An `<img>` cannot send a bearer token, so the permission rides in the query.
 */
export function stillUrl(
  media: Pick<MediaContext, 'publicUrl' | 'mediaSecret'>,
  videoId: string,
  atSec: number,
  now: number = Date.now()
): string {
  const token = signQueryToken(media.mediaSecret, stillSubject(videoId), now)
  return `${media.publicUrl}/api/v1/videos/${videoId}/stills/${stillSecond(atSec)}.jpg?t=${token}`
}

/** A presigned GET for a still in the Space, good for `expiresSec`. */
export function stillSpaceUrl(
  space: SpaceSettings,
  videoId: string,
  atSec: number,
  expiresSec: number
): string {
  return presignGetUrl({ ...space, key: stillKey(videoId, atSec), expiresSec })
}

/** Whether the Space already holds this still. */
export async function stillInSpace(
  space: SpaceSettings,
  videoId: string,
  atSec: number
): Promise<boolean> {
  try {
    const response = await fetch(stillSpaceUrl(space, videoId, atSec, 300), {
      headers: { range: 'bytes=0-0' },
      signal: AbortSignal.timeout(15000)
    })
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}

const inFlight = new Map<string, Promise<string>>()

/**
 * Makes sure the Space holds this still, and returns its key.
 *
 * Two requests for the same still arriving together must not both run FFmpeg.
 * The first one's promise is shared, and dropped as soon as it settles, so a
 * failure is retried rather than remembered.
 */
export async function ensureStill(options: StillOptions): Promise<string> {
  const { space, videoId, atSec } = options
  if (!spaceConfigured(space)) {
    throw new Error('No Space is configured to keep stills in')
  }
  const key = stillKey(videoId, atSec)
  const running = inFlight.get(key)
  if (running != null) return await running

  const work = (async () => {
    if (await stillInSpace(space, videoId, atSec)) return key
    await cutAndKeep(options, key)
    return key
  })().finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, work)
  return await work
}

async function cutAndKeep(options: StillOptions, key: string): Promise<void> {
  const { ffmpegPath, source, space, atSec, width = 480 } = options
  const scratch = await mkdtemp(join(tmpdir(), 'ts-still-'))
  try {
    const frame = await openFrame(source, stillSecond(atSec), scratch)
    if (frame == null) {
      throw new Error(`No frame at ${atSec}s of ${options.videoId}`)
    }
    const path = join(scratch, 'still.jpg')
    try {
      await cutFrame(ffmpegPath, frame, path, width, atSec)
    } finally {
      await frame.release()
    }
    await putObject({
      space,
      key,
      body: await readFile(path),
      contentType: 'image/jpeg'
    })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * The file FFmpeg reads and where the moment sits inside it.
 *
 * A local video is read where it lies, and the seek is the moment itself. A
 * fragment pulled out of the Space starts partway through the game, so the
 * seek is measured from the fragment's own start instead.
 */
async function openFrame(
  source: FrameSource,
  atSec: number,
  scratch: string
): Promise<
  { path: string; seekSec: number; release: () => Promise<void> } | undefined
> {
  if (source.kind === 'file') {
    return {
      path: source.path,
      seekSec: atSec,
      release: async () => undefined
    }
  }
  return await fetchSpaceFrame({
    space: source.space,
    videoId: source.videoId,
    atSec,
    workDir: scratch
  })
}

async function cutFrame(
  ffmpegPath: string,
  frame: { path: string; seekSec: number },
  path: string,
  width: number,
  atSec: number
): Promise<string> {
  await run(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      // Before `-i`, so FFmpeg seeks to the keyframe rather than decoding
      // everything up to this point.
      '-ss',
      String(frame.seekSec),
      '-i',
      frame.path,
      '-frames:v',
      '1',
      // `-2` keeps the aspect ratio and an even height, which JPEG wants.
      '-vf',
      `scale=${width}:-2`,
      '-q:v',
      '4',
      path
    ],
    { maxBuffer: 1 << 22 }
  )

  const size = await fileSize(path)
  if (size == null || size === 0) {
    // Past the end of the video, or a moment FFmpeg could not decode. Saying
    // so beats leaving a zero-byte file to be served as a picture.
    throw new Error(`No frame at ${atSec}s of ${frame.path}`)
  }
  return path
}

export interface WarmOptions {
  ffmpegPath: string
  source: FrameSource
  space: SpaceSettings
  videoId: string
  /** The seconds to have ready, usually one per highlight. */
  seconds: number[]
  /** How many FFmpeg runs at once. */
  concurrency?: number
}

/**
 * Makes sure every highlight of a video has its still.
 *
 * Bounded, because this is the one place the server decodes anything and a
 * game has dozens of highlights: without a limit, opening a game would start
 * fifty FFmpeg processes at once. Failures are swallowed on purpose — a
 * missing still is a missing thumbnail, not a failed request.
 */
export async function warmStills(options: WarmOptions): Promise<number> {
  const { seconds, concurrency = 4, ...rest } = options
  const wanted = [...new Set(seconds.map(stillSecond))]
  let made = 0
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < wanted.length) {
      const atSec = wanted[next++]
      try {
        await ensureStill({ ...rest, atSec })
        made += 1
      } catch {
        // Past the end, or a frame FFmpeg could not read. Skipped quietly.
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, wanted.length) }, worker)
  )
  return made
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}
