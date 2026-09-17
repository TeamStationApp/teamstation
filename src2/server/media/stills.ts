import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

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

export interface StillOptions {
  ffmpegPath: string
  /** The file to read the frame out of. */
  videoPath: string
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
  const { ffmpegPath, videoPath, atSec, width = 480 } = options
  await mkdir(join(path, '..'), { recursive: true })

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
      String(stillSecond(atSec)),
      '-i',
      videoPath,
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
    throw new Error(`No frame at ${atSec}s of ${videoPath}`)
  }
  return path
}

export interface WarmOptions {
  ffmpegPath: string
  videoPath: string
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
