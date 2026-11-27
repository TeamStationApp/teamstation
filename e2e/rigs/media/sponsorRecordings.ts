import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { makeDatabase } from '../../../src/server/db/database'
import { ingestVideoFile } from '../../../src/server/media/ingestFile'
import type { AttachedHandle } from '../../core/attach'
import { nodeDatabaseUrl } from '../../core/dropletStack'
import { requireStreamingHandle } from '../../core/streamingStack'
import {
  DropletPublisher,
  requirePublisher
} from '../streaming/dropletPublisher'
import { rtmpUrl } from '../streaming/streamingSession'
import { stackSpace } from './stackSpace'

const run = promisify(execFile)

/**
 * The recordings the sponsor scenarios and captures play, made on the
 * stack's own Space. Both steps are the same on a stack of the base and one
 * of the branch, so a before and its after differ only in the sponsor setup
 * made through the API ahead of them.
 */

/** One angle of an uploaded recording. */
export interface RecordedAngle {
  title: string
  durationSec: number
}

/**
 * "Home Plate" long enough for the previews' 30:00–32:00 window, and three
 * ten-minute angles beside it.
 */
export const SPONSOR_ANGLES: readonly RecordedAngle[] = [
  { title: 'Home Plate', durationSec: 40 * 60 },
  { title: 'First Base', durationSec: 10 * 60 },
  { title: 'Third Base', durationSec: 10 * 60 },
  { title: 'Outfield', durationSec: 10 * 60 }
]

/** The pinned build's name on this Mac, or `TS_FFMPEG`. */
const ffmpegPath = (): string => process.env.TS_FFMPEG ?? 'ffmpeg'

/**
 * A synthetic clip: the moving test pattern (its own counter is the burned-in
 * clock) and a tone, 640 × 360 at 30 fps, H.264 and AAC.
 */
export function syntheticClipArgs(
  durationSec: number,
  file: string,
  tone = 440
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=640x360:rate=30:duration=${durationSec}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${tone}:sample_rate=48000:duration=${durationSec}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '60',
    '-b:v',
    '600k',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-shortest',
    '-movflags',
    '+faststart',
    file
  ]
}

/**
 * An uploaded recording of `gameId`: each angle made here, then taken in by
 * `ingestVideoFile` against the stack's database and Space, as an upload
 * is, from `startAt`. Answers each angle's video id by title.
 */
export async function recordGame(
  handle: AttachedHandle,
  options: {
    gameId: string
    startAt: Date
    runDir: string
    angles?: readonly RecordedAngle[]
  }
): Promise<Record<string, string>> {
  const streaming = requireStreamingHandle(handle)
  const space = await stackSpace(streaming)
  const db = makeDatabase(nodeDatabaseUrl(streaming.databaseUrl))
  const angles = options.angles ?? SPONSOR_ANGLES
  mkdirSync(options.runDir, { recursive: true })
  try {
    const videos: Record<string, string> = {}
    for (const [index, angle] of angles.entries()) {
      const file = join(
        options.runDir,
        `${angle.title.replace(/\W+/g, '-').toLowerCase()}.mp4`
      )
      await run(
        ffmpegPath(),
        syntheticClipArgs(angle.durationSec, file, 440 + index * 110),
        { maxBuffer: 1 << 24 }
      )
      const ingested = await ingestVideoFile({
        db,
        space,
        ffmpegPath: ffmpegPath(),
        file,
        gameId: options.gameId,
        kind: 'program',
        title: angle.title,
        startAt: options.startAt,
        startAtSource: 'manual',
        log: () => undefined
      })
      videos[angle.title] = ingested.videoId
    }
    return videos
  } finally {
    await db.destroy()
  }
}

/** The four labels the publisher droplet has fixtures for. */
export const SPONSOR_LABELS = ['SynthA', 'SynthB', 'SynthC', 'SynthD'] as const

/**
 * A live recording of `gameId`: a camera per label made through
 * `POST /games/:gameId/live-streams` as `token`, each sent by the stack's
 * publisher droplet, started together. The caller stops each when its
 * recording ends. Each key's URL goes to a mode-600 file in `runDir`, never
 * into an artifact.
 */
export async function publishGame(
  handle: AttachedHandle,
  options: {
    gameId: string
    token: string
    runDir: string
    labels?: readonly string[]
  },
  fetchFn: typeof fetch = fetch
): Promise<DropletPublisher[]> {
  const streaming = requireStreamingHandle(handle)
  const publisher = requirePublisher(streaming)
  mkdirSync(options.runDir, { recursive: true })
  const cameras: DropletPublisher[] = []
  for (const label of options.labels ?? SPONSOR_LABELS) {
    const made = await fetchFn(
      `${streaming.api}/games/${options.gameId}/live-streams`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ label, source: 'rtmp' })
      }
    )
    const body = (await made.json().catch(() => ({}))) as { url?: string }
    if (made.status !== 201 || typeof body.url !== 'string')
      throw new Error(`no camera ${label}: ${made.status}`)
    const key = body.url.split('/').pop()!
    const urlFile = join(options.runDir, `rtmp-${label}`)
    writeFileSync(urlFile, rtmpUrl(streaming, key), { mode: 0o600 })
    cameras.push(new DropletPublisher({ publisher, label, urlFile }, fetchFn))
  }
  await Promise.all(
    cameras.map(async camera => {
      await camera.start()
    })
  )
  return cameras
}
