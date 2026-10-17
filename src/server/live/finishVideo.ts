import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'

import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'
import {
  ffprobeFor,
  MASTER_PLAYLIST,
  MEDIA_PLAYLIST,
  probeDuration,
  probeVideoStream,
  remuxToHls,
  VIDEO_FILE
} from '../media/ffmpeg'
import { isStampedAt, readRecordingStamps } from '../media/wallClockScan'
import { storeWallPoints } from '../media/wallTimeline'
import { fillHoles } from './holeFiller'
import {
  FRAME_SLACK_SEC,
  listedSegments,
  readLeadingBoxes,
  timelineStartSec
} from './segmentClock'
import { LIVE_PLAYLIST_NAME } from './splitter'

/**
 * Turning a finished live stream into an ordinary recording.
 *
 * While a game is on, the stream is a growing playlist and a segment every few
 * seconds, because that is what a viewer can join in the middle of. A finished
 * game is a different thing: it is watched from the start, seeked around, and
 * has to be stored somewhere cheap. Every other recording in TeamStation is one
 * fragmented MP4 with a byte-range playlist, which is what lets a video in the
 * Space need **one** presigned URL instead of one per segment.
 *
 * So the segments are remuxed into that shape the moment the stream ends. It is
 * still `-c copy` — the same pictures, in one file instead of two thousand —
 * and afterwards the video is indistinguishable from an uploaded one, so
 * everything downstream (the Space, the playlist rewriting, stills) works
 * without knowing this video was ever live.
 */

/** The files a live stream leaves behind, alongside the recording it becomes. */
export function isLivePart(name: string): boolean {
  return name === 'init.mp4' || /^seg\d+\.m4s$/.test(name)
}

export interface VodResult {
  durationSec: number
  width?: number
  height?: number
  codecName: string
  codecTag: string
  /** The recording's own files, which are what goes to the Space. */
  files: string[]
}

/**
 * Remuxes a closed live playlist in place, and takes the segments away.
 *
 * The remux writes into a subdirectory first and the files are moved up only
 * once it has finished, so a crash in the middle leaves the live playlist
 * standing rather than a half-written recording where a game used to be.
 *
 * A playlist whose holes were filled that then fails to remux is logged and
 * remuxed again with its holes unfilled, as it packed before the filler
 * existed, so a fault only the filler causes never leaves a game unpacked.
 */
export async function toRecording(
  ffmpegPath: string,
  dir: string,
  log: (message: string) => void = console.log
): Promise<VodResult> {
  const staging = join(dir, '.vod')
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  const playlistPath = join(dir, LIVE_PLAYLIST_NAME)
  try {
    const { source, unfilled } = await remuxSources(dir, ffmpegPath, log)
    try {
      await remuxToHls(ffmpegPath, {
        input: source,
        outDir: staging,
        concatList: source !== playlistPath
      })
    } catch (error) {
      if (unfilled == null) throw error
      log(
        `live: ${dir}: remux of the filled holes failed, remuxing them unfilled: ${String(error)}`
      )
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })
      await remuxToHls(ffmpegPath, {
        input: unfilled,
        outDir: staging,
        concatList: true
      })
    }
  } finally {
    await rm(join(dir, '.holes'), { recursive: true, force: true })
  }

  const probe = await probeVideoStream(
    ffprobeFor(ffmpegPath),
    join(staging, VIDEO_FILE)
  )
  const durationSec = await probeDuration(
    ffprobeFor(ffmpegPath),
    join(staging, MEDIA_PLAYLIST)
  )

  // The segments stay where they are.
  //
  // Somebody is watching this game — that is what a game that has just ended
  // means — and their player is holding the live playlist and asking for the
  // next segment by name. Deleting the segments the moment the remux finished
  // took the end of the game away from exactly the people who cared most about
  // it. They go when the local copy does, hours later.
  //
  // The playlist itself is replaced, so anybody arriving afterwards gets the
  // recording rather than a live stream that has stopped.
  const files: string[] = []
  for (const name of await readdir(staging)) {
    await rename(join(staging, name), join(dir, name))
    files.push(name)
  }
  await rm(staging, { recursive: true, force: true })

  return {
    durationSec,
    width: probe.width,
    height: probe.height,
    codecName: probe.codecName,
    codecTag: probe.codecTag,
    files: files.sort()
  }
}

/**
 * Whether the listed segments leave a gap the public file has to keep.
 *
 * Continuous segments sit about a frame past the previous `#EXTINF`. A wider
 * gap is the absence the live timestamps already record, down to about one
 * frame, and the remux keeps it.
 */
export function timelineHole(
  pieces: ReadonlyArray<{ start: number; duration: number }>
): boolean {
  return pieces.some((piece, index) => {
    if (index === 0) return false
    const previous = pieces[index - 1]
    return piece.start - previous.start > previous.duration + FRAME_SLACK_SEC
  })
}

/**
 * The file a live playlist should be remuxed from.
 *
 * A playlist whose segments sit apart on the wall clock is assembled first:
 * each segment keeps the start written in its `sidx`, and the gap between
 * those starts is the absence. The public file keeps that hole, filled with
 * black pictures at the stream's frame rate and with silence (see
 * `holeFiller.ts`), so every picture lasts one frame and the return opens at
 * its wall time. The list points the concat demuxer at each init-and-segment
 * pair in place, so the finish does not copy the stream beside itself; only
 * the init segment is rewritten, to carry the filler's parameter sets. A
 * stream whose holes cannot be filled is listed as it stands, and the remux
 * keeps the holes as they are. Continuous segments sit about a frame past the
 * previous `#EXTINF` and are remuxed as they stand.
 */
export async function fileForRemux(
  dir: string,
  ffmpegPath: string,
  log: (message: string) => void = console.log
): Promise<string> {
  return (await remuxSources(dir, ffmpegPath, log)).source
}

/**
 * `fileForRemux`'s answer, and, when that is a hole-filled list, the same
 * segments listed unfilled for a remux to fall back on.
 */
async function remuxSources(
  dir: string,
  ffmpegPath: string,
  log: (message: string) => void
): Promise<{ source: string; unfilled?: string }> {
  const playlistPath = join(dir, LIVE_PLAYLIST_NAME)
  const asIs = { source: playlistPath }
  const playlist = await readFile(playlistPath, 'utf8').catch(() => '')
  const listed = listedSegments(playlist)
  if (listed.length < 2) return asIs
  const init = await readFile(join(dir, 'init.mp4')).catch(() => undefined)
  if (init == null) return asIs
  const pieces: Array<{
    name: string
    duration: number
    start: number
    path: string
  }> = []
  for (const item of listed) {
    const path = join(dir, item.name)
    const bytes = await readLeadingBoxes(path).catch(() => undefined)
    if (bytes == null) return asIs
    const start = timelineStartSec(init, bytes)
    if (start == null) return asIs
    pieces.push({ name: item.name, duration: item.durationSec, start, path })
  }
  if (!timelineHole(pieces)) return asIs

  const scratch = join(dir, '.holes')
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const initPath = join(dir, 'init.mp4')
  const isHole = (index: number): boolean =>
    timelineHole([pieces[index], pieces[index + 1]])
  let lines: string[] | undefined
  try {
    const filled = await fillHoles(
      ffmpegPath,
      initPath,
      pieces,
      isHole,
      scratch
    )
    if (typeof filled === 'string') {
      log(`live: ${dir}: holes kept unfilled: ${filled}`)
    } else {
      lines = filled.lines
    }
  } catch (error) {
    log(`live: ${dir}: holes kept unfilled: ${String(error)}`)
  }
  const plain = ['ffconcat version 1.0']
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]
    const pair = `concat:${initPath}|${piece.path}`
    plain.push(`file '${pair.replaceAll("'", "'\\''")}'`)
    if (index + 1 < pieces.length) {
      plain.push(
        `duration ${(pieces[index + 1].start - piece.start).toFixed(6)}`
      )
    }
  }
  const unfilled = join(scratch, 'unfilled.txt')
  await writeFile(unfilled, `${plain.join('\n')}\n`)
  if (lines == null) return { source: unfilled }
  const list = join(scratch, 'list.txt')
  await writeFile(list, `${lines.join('\n')}\n`)
  return { source: list, unfilled }
}

/** Whether a directory has already been turned into a recording. */
export async function isRecordingShape(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch((): string[] => [])
  return names.includes(VIDEO_FILE) && names.includes(MASTER_PLAYLIST)
}

/**
 * Moves a finished stream's wall-clock points onto the recording it became.
 *
 * A stream that carried the SEI is scanned again, in the recording's own
 * file and on its own playlist, and its points replace the live `sei` ones
 * in one transaction: they are the same frames, but the recording is what
 * everybody will play from now on. Answers how many points it wrote.
 *
 * Whether it carried the SEI is read from the points stored while it was
 * live: one `sei` point is enough, and asking is one query on the anchors'
 * key. A stream with none is not scanned at all, so a multi-hour stream from
 * any other publisher costs no second read of its whole file to find nothing.
 *
 * An `arrival` point stays where the recording's frames are not stamped: a
 * stream can change publisher at a reconnect, from one that stamps nothing to
 * TS Director or back, and the stretch without stamps keeps the only times it
 * has. Each is at its segment's start on the live playlist, the sum of the
 * `EXTINF` before it, and the remux is the same segments end to end, so that
 * is still where the segment starts in the recording: to about a frame for
 * each reconnect before it, because a writer's last segment is listed a
 * frame short and the remux counts it whole. Arrival is only ever good to a
 * second or so. One whose segment the recording does find stamped goes, as a
 * stamped stream's first segment does when it could not be read live.
 *
 * Which an arrival point is, is read halfway along its segment, to the next
 * point stored: a reconnect's frame can put the point itself on the last
 * stamped frame before it, but never half a segment away.
 */
export async function replaceAnchorsFromRecording(
  db: Kysely<Database>,
  videoId: string,
  dir: string
): Promise<number> {
  const stamped = await db
    .selectFrom('video_wall_anchors')
    .select('media_ms')
    .where('video_id', '=', videoId)
    .where('source', '=', 'sei')
    .limit(1)
    .executeTakeFirst()
  if (stamped == null) return 0
  const scan = await readRecordingStamps(dir)
  if (scan.points.length === 0) return 0
  await db.transaction().execute(async trx => {
    // Each arrival point, with the media time of the point after it.
    const { rows: arrivals } = await sql<{
      mediaMs: number
      nextMs: number | null
    }>`
      select media_ms as "mediaMs", next_ms as "nextMs"
      from (
        select media_ms, source,
          lead(media_ms) over (order by media_ms) as next_ms
        from video_wall_anchors
        where video_id = ${videoId}
      ) as anchor
      where source = 'arrival'`.execute(trx)
    const covered = arrivals
      .filter(({ mediaMs, nextMs }) =>
        isStampedAt(scan.stamped, (mediaMs + (nextMs ?? scan.durationMs)) / 2)
      )
      .map(({ mediaMs }) => mediaMs)
    await trx
      .deleteFrom('video_wall_anchors')
      .where('video_id', '=', videoId)
      .where(eb =>
        covered.length === 0
          ? eb('source', '=', 'sei')
          : eb.or([eb('source', '=', 'sei'), eb('media_ms', 'in', covered)])
      )
      .execute()
    await storeWallPoints(
      trx,
      videoId,
      scan.points.map(point => ({ ...point, source: 'sei' }))
    )
  })
  return scan.points.length
}
