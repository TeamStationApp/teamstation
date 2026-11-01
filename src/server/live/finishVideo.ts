import { createReadStream, createWriteStream } from 'node:fs'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

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
import { boxesIn, fillHoles } from './holeFiller'
import {
  FIRST_INIT,
  FRAME_SLACK_SEC,
  isInitName,
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
  return isInitName(name) || /^seg\d+\.m4s$/.test(name)
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
 *
 * A recording that changed configuration part way (`absorbWriterPlaylist`) has
 * more than one init segment, which one fragmented MP4's one sample entry
 * cannot hold, and which FFmpeg will not read across. Each configuration is
 * remuxed by itself and the results follow each other in the one file, each
 * with its own `moov`: `video.mp4` is then read only by its playlist, whose
 * `EXT-X-MAP` byte ranges say where each starts. It is still one object in the
 * Space and one presigned URL.
 */
export async function toRecording(
  ffmpegPath: string,
  dir: string,
  log: (message: string) => void = console.log
): Promise<VodResult> {
  const staging = join(dir, '.vod')
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  const parts = configurationRuns(
    await readFile(join(dir, LIVE_PLAYLIST_NAME), 'utf8').catch(() => ''),
    await moovsOf(dir)
  )
  if (parts.length > 1) {
    await remuxRuns(ffmpegPath, dir, staging, parts, log)
  } else {
    await remuxOne(
      ffmpegPath,
      dir,
      join(dir, LIVE_PLAYLIST_NAME),
      FIRST_INIT,
      staging,
      log
    )
  }

  // Of the first configuration, which is all a demuxer reads of the file.
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

/** One playlist's remux into `outDir`, holes and their fallback as above. */
async function remuxOne(
  ffmpegPath: string,
  dir: string,
  playlistPath: string,
  initName: string,
  outDir: string,
  log: (message: string) => void
): Promise<void> {
  try {
    const { source, unfilled } = await remuxSources(
      dir,
      ffmpegPath,
      log,
      playlistPath,
      initName
    )
    try {
      await remuxToHls(ffmpegPath, {
        input: source,
        outDir,
        concatList: source !== playlistPath
      })
    } catch (error) {
      if (unfilled == null) throw error
      log(
        `live: ${dir}: remux of the filled holes failed, remuxing them unfilled: ${String(error)}`
      )
      await rm(outDir, { recursive: true, force: true })
      await mkdir(outDir, { recursive: true })
      await remuxToHls(ffmpegPath, {
        input: unfilled,
        outDir,
        concatList: true
      })
    }
  } finally {
    await rm(join(dir, '.holes'), { recursive: true, force: true })
  }
}

/** The part of a live playlist that one configuration wrote, in order. */
export interface ConfigurationRun {
  /** The init segment its segments are remuxed with. */
  init: string
  /** Its lines, as a playlist of its own without its head. */
  lines: string[]
}

/**
 * Splits a live playlist where its configuration changes.
 *
 * Writers after a change have an init segment each, and neighbouring ones from
 * the same camera write the same `moov`: those stay one run, so that the holes
 * between them are filled as any other's. Anything of which `moovs` has no
 * record is its own run.
 */
export function configurationRuns(
  playlist: string,
  moovs: ReadonlyMap<string, string>
): ConfigurationRun[] {
  const runs: ConfigurationRun[] = []
  let run: ConfigurationRun | undefined
  for (const raw of playlist.split('\n')) {
    const line = raw.trim()
    if (line === '#EXT-X-ENDLIST') continue
    if (line.startsWith('#EXT-X-MAP:')) {
      const init = /URI="([^"]+)"/.exec(line)?.[1] ?? FIRST_INIT
      const same =
        run != null &&
        moovs.get(run.init) != null &&
        moovs.get(run.init) === moovs.get(init)
      if (same) continue
      if (run != null) {
        // The discontinuity above this map is where the runs meet now.
        if (run.lines.at(-1) === '#EXT-X-DISCONTINUITY') run.lines.pop()
        runs.push(run)
      }
      run = { init, lines: [] }
    } else if (run != null) {
      run.lines.push(line)
    }
  }
  return run == null ? [] : [...runs, run]
}

/** Each init segment in a directory, and its `moov`. */
async function moovsOf(dir: string): Promise<Map<string, string>> {
  const moovs = new Map<string, string>()
  for (const name of await readdir(dir).catch((): string[] => [])) {
    if (!isInitName(name)) continue
    const init = await readFile(join(dir, name)).catch(() => undefined)
    const moov =
      init == null
        ? undefined
        : boxesIn(init, 0, init.length).find(box => box.type === 'moov')
    if (init != null && moov != null) {
      moovs.set(name, init.subarray(moov.start, moov.end).toString('base64'))
    }
  }
  return moovs
}

/**
 * Remuxes each run by itself into `staging`, then joins them there into the
 * one file a recording is, with one media playlist and the first run's master.
 */
async function remuxRuns(
  ffmpegPath: string,
  dir: string,
  staging: string,
  runs: ConfigurationRun[],
  log: (message: string) => void
): Promise<void> {
  const remuxed: string[] = []
  for (const [index, run] of runs.entries()) {
    const playlistPath = join(dir, `.run${String(index)}.m3u8`)
    const outDir = join(staging, `run${String(index)}`)
    await mkdir(outDir, { recursive: true })
    await writeFile(playlistPath, runPlaylist(run))
    try {
      await remuxOne(ffmpegPath, dir, playlistPath, run.init, outDir, log)
    } finally {
      await rm(playlistPath, { force: true })
    }
    remuxed.push(outDir)
  }

  const playlists: string[] = []
  let offset = 0
  const video = join(staging, VIDEO_FILE)
  for (const outDir of remuxed) {
    playlists.push(
      shiftByteRanges(
        await readFile(join(outDir, MEDIA_PLAYLIST), 'utf8'),
        offset
      )
    )
    const file = join(outDir, VIDEO_FILE)
    offset += (await stat(file)).size
    await pipeline(
      createReadStream(file),
      createWriteStream(video, { flags: 'a' })
    )
  }
  await writeFile(join(staging, MEDIA_PLAYLIST), joinMediaPlaylists(playlists))
  await rename(
    join(remuxed[0], MASTER_PLAYLIST),
    join(staging, MASTER_PLAYLIST)
  )
  for (const outDir of remuxed) {
    await rm(outDir, { recursive: true, force: true })
  }
}

/** A run as a closed playlist of its own, for the HLS demuxer to read. */
function runPlaylist(run: ConfigurationRun): string {
  const longestSec = Math.max(
    1,
    ...run.lines.flatMap(line =>
      line.startsWith('#EXTINF:')
        ? [Math.ceil(Number.parseFloat(line.slice('#EXTINF:'.length)))]
        : []
    )
  )
  const start = run.lines.findIndex(
    line => line.startsWith('#EXTINF:') || line.startsWith('#EXT-X-PROGRAM')
  )
  return `${[
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${String(longestSec)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${run.init}"`,
    ...run.lines.slice(Math.max(0, start)).filter(line => line !== ''),
    '#EXT-X-ENDLIST'
  ].join('\n')}\n`
}

/** A single-file media playlist with its byte ranges moved along its file. */
export function shiftByteRanges(playlist: string, offset: number): string {
  return playlist
    .replace(
      /(#EXT-X-MAP:.*BYTERANGE=")(\d+)@(\d+)"/g,
      (_line, head: string, length: string, at: string) =>
        `${head}${length}@${String(Number(at) + offset)}"`
    )
    .replace(
      /^#EXT-X-BYTERANGE:(\d+)@(\d+)$/gm,
      (_line, length: string, at: string) =>
        `#EXT-X-BYTERANGE:${length}@${String(Number(at) + offset)}`
    )
}

/**
 * Single-file media playlists as one, each after the first behind a
 * discontinuity and its own `EXT-X-MAP`. The timestamps of each start again,
 * which is what a discontinuity tells a player to expect. The target duration
 * is the largest of theirs, as every segment has to fit under it.
 */
export function joinMediaPlaylists(playlists: readonly string[]): string {
  let targetSec = 0
  const body: string[] = []
  const [first] = playlists
  for (const [index, playlist] of playlists.entries()) {
    const lines = playlist.trimEnd().split('\n')
    const map = lines.findIndex(line => line.startsWith('#EXT-X-MAP:'))
    for (const line of lines) {
      const target = /^#EXT-X-TARGETDURATION:(\d+)$/.exec(line)
      if (target != null) targetSec = Math.max(targetSec, Number(target[1]))
    }
    if (index > 0) body.push('#EXT-X-DISCONTINUITY')
    body.push(...lines.slice(map).filter(line => line !== '#EXT-X-ENDLIST'))
  }
  const head = first.split('\n')
  const headEnd = head.findIndex(line => line.startsWith('#EXT-X-MAP:'))
  return `${[
    ...head
      .slice(0, headEnd)
      .map(line =>
        line.startsWith('#EXT-X-TARGETDURATION:')
          ? `#EXT-X-TARGETDURATION:${String(targetSec)}`
          : line
      ),
    ...body,
    '#EXT-X-ENDLIST'
  ].join('\n')}\n`
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
  log: (message: string) => void,
  playlistPath: string = join(dir, LIVE_PLAYLIST_NAME),
  initName: string = FIRST_INIT
): Promise<{ source: string; unfilled?: string }> {
  const asIs = { source: playlistPath }
  const playlist = await readFile(playlistPath, 'utf8').catch(() => '')
  const listed = listedSegments(playlist)
  if (listed.length < 2) return asIs
  const init = await readFile(join(dir, initName)).catch(() => undefined)
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
  const initPath = join(dir, initName)
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
  dir: string,
  playlistFile: string = MEDIA_PLAYLIST
): Promise<number> {
  const stamped = await db
    .selectFrom('video_wall_anchors')
    .select('media_ms')
    .where('video_id', '=', videoId)
    .where('source', '=', 'sei')
    .limit(1)
    .executeTakeFirst()
  if (stamped == null) return 0
  const scan = await readRecordingStamps(dir, { playlistFile })
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
