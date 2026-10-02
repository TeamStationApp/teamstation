import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { fetchSpaceFrame } from './spaceFrames'
import type { SpaceSettings } from './spacesHls'

const run = promisify(execFile)

/**
 * One frame of a video, as a small JPEG.
 *
 * This is the only decoding the server ever does, and it is one frame: `-ss`
 * before `-i` makes FFmpeg seek rather than decode up to the point, so it
 * reads the few byte ranges around that timestamp and nothing else. The
 * results are cached, because a highlight list asks for the same handful of
 * moments over and over.
 *
 * Stills are cached under the work directory, never written beside the video:
 * PeerTube's tree is read-only to us, and the Space holds only what a player
 * needs.
 */

/**
 * Where a video's frames are read from.
 *
 * A video on this host is a path. One that has gone to the Space is named
 * rather than located, because reading a frame out of it means fetching the
 * fragment that holds it first — see `spaceFrames.ts`. Which of the two it is
 * only matters on a cache miss, so a still that has already been cut costs the
 * same either way.
 */
export type FrameSource =
  | { kind: 'file'; path: string }
  | { kind: 'space'; space: SpaceSettings; videoId: string }

export interface StillOptions {
  ffmpegPath: string
  /** Where the frame is read from. */
  source: FrameSource
  /** Where `stills/<videoId>/` lives. */
  workDir: string
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

export function stillPath(
  workDir: string,
  videoId: string,
  atSec: number
): string {
  return join(workDir, 'stills', videoId, `${stillSecond(atSec)}.jpg`)
}

/**
 * Two requests for the same still arriving together must not both run FFmpeg.
 * The first one's promise is shared, and dropped as soon as it settles, so a
 * failure is retried rather than remembered.
 */
const inFlight = new Map<string, Promise<string>>()

/** The path to the still, generating it first if it is not already cached. */
export async function ensureStill(options: StillOptions): Promise<string> {
  const path = stillPath(options.workDir, options.videoId, options.atSec)

  const cached = await fileSize(path)
  if (cached != null && cached > 0) return path

  const running = inFlight.get(path)
  if (running != null) return await running

  const work = makeStill({ ...options }, path).finally(() => {
    inFlight.delete(path)
  })
  inFlight.set(path, work)
  return await work
}

async function makeStill(options: StillOptions, path: string): Promise<string> {
  const { ffmpegPath, source, atSec, width = 480 } = options
  await mkdir(join(path, '..'), { recursive: true })

  const frame = await openFrame(source, stillSecond(atSec), options.workDir)
  if (frame == null) {
    throw new Error(`No frame at ${atSec}s of ${options.videoId}`)
  }

  try {
    return await cutFrame(ffmpegPath, frame, path, width, atSec)
  } finally {
    await frame.release()
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
  workDir: string
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
    workDir
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
  workDir: string
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
