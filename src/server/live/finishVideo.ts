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
  /**
   * Where the file moved a stretch of the live playlist's time, by the gaps it
   * keeps at its joins, for `moveWallPoints`. Empty for one with no such gap.
   */
  moved: MovedStretch[]
}

/** From this live position on, the recording is `byMs` further along. */
export interface MovedStretch {
  fromMs: number
  byMs: number
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
 * Space and one presigned URL. The gap where two configurations meet stays in
 * the file, filled as a hole is, so its positions keep to the clock.
 */
export async function toRecording(
  ffmpegPath: string,
  dir: string,
  log: (message: string) => void = console.log
): Promise<VodResult> {
  const staging = join(dir, '.vod')
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  const live = await readFile(join(dir, LIVE_PLAYLIST_NAME), 'utf8').catch(
    () => ''
  )
  const parts = configurationRuns(live, await moovsOf(dir))
  const span = await recordingSpanSec(dir, live)
  let largest: PictureSize | undefined
  let moved: MovedStretch[] = []
  if (parts.length > 1) {
    ;({ largest, moved } = await remuxRuns(
      ffmpegPath,
      dir,
      staging,
      parts,
      log
    ))
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

  // Of the first configuration, which is all a demuxer reads of the file. Its
  // size is the largest of any, as the master says: the size of the first
  // part alone undersold a recording that went on at a larger one.
  const probe = await probeVideoStream(
    ffprobeFor(ffmpegPath),
    join(staging, VIDEO_FILE)
  )
  const durationSec = Math.max(
    span ?? 0,
    await probeDuration(ffprobeFor(ffmpegPath), join(staging, MEDIA_PLAYLIST))
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
    width: largest?.width ?? probe.width,
    height: largest?.height ?? probe.height,
    codecName: probe.codecName,
    codecTag: probe.codecTag,
    files: files.sort(),
    moved
  }
}

/** Where a listed segment starts on the programme clock, when it can be read. */
async function clockStartSec(
  dir: string,
  segment: { name: string; init: string }
): Promise<number | undefined> {
  const init = await readFile(join(dir, segment.init)).catch(() => undefined)
  const bytes = await readLeadingBoxes(join(dir, segment.name)).catch(
    () => undefined
  )
  return init == null || bytes == null
    ? undefined
    : timelineStartSec(init, bytes)
}

/**
 * How long a recording that changed configuration spans on the clock, first
 * picture to last, or nothing for one that did not or cannot be read.
 *
 * The sum of a live playlist's lengths leaves out the gap at each join, and an
 * upload's coverage is judged against the row's length: short of it, an upload
 * of the first part alone counts as reaching the stream's end. This is what the
 * row says while the recording is on the Space's live origin, whose playlist
 * cannot carry the gap, and for a gap too long to fill.
 */
export async function recordingSpanSec(
  dir: string,
  playlist: string
): Promise<number | undefined> {
  const listed = listedSegments(playlist)
  if (new Set(listed.map(segment => segment.init)).size < 2) return undefined
  const last = listed[listed.length - 1]
  const startSec = await clockStartSec(dir, listed[0])
  const lastSec = await clockStartSec(dir, last)
  return startSec == null || lastSec == null
    ? undefined
    : lastSec + last.durationSec - startSec
}

/**
 * Puts a recording's wall-clock points where its file has their frames, after
 * `toRecording` kept the gaps at its joins: they were stored on the live
 * playlist's time, which has none.
 */
export async function moveWallPoints(
  db: Kysely<Database>,
  videoId: string,
  moved: readonly MovedStretch[]
): Promise<void> {
  if (moved.length === 0) return
  await db.transaction().execute(async trx => {
    const points = await trx
      .deleteFrom('video_wall_anchors')
      .where('video_id', '=', videoId)
      .where('media_ms', '>=', moved[0].fromMs)
      .returningAll()
      .execute()
    const POINTS_PER_INSERT = 1000
    for (let at = 0; at < points.length; at += POINTS_PER_INSERT) {
      await trx
        .insertInto('video_wall_anchors')
        .values(
          points.slice(at, at + POINTS_PER_INSERT).map(point => {
            const stretch = moved.findLast(one => one.fromMs <= point.media_ms)
            return { ...point, media_ms: point.media_ms + (stretch?.byMs ?? 0) }
          })
        )
        .execute()
    }
  })
}

/**
 * One playlist's remux into `outDir`, holes and their fallback as above, up to
 * `joinAt` on the clock when another configuration starts there.
 */
async function remuxOne(
  ffmpegPath: string,
  dir: string,
  playlistPath: string,
  initName: string,
  outDir: string,
  log: (message: string) => void,
  joinAt?: number
): Promise<void> {
  try {
    const { source, unfilled } = await remuxSources(
      dir,
      ffmpegPath,
      log,
      playlistPath,
      initName,
      joinAt
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
 * one file a recording is, with one media playlist and one master for every
 * run (`combinedMaster`). Each run goes on to where the next starts on the
 * clock, so the gap between them stays in the file. Answers the largest picture
 * of any run, and what that moved.
 */
async function remuxRuns(
  ffmpegPath: string,
  dir: string,
  staging: string,
  runs: ConfigurationRun[],
  log: (message: string) => void
): Promise<{ largest: PictureSize | undefined; moved: MovedStretch[] }> {
  const remuxed: string[] = []
  for (const [index, run] of runs.entries()) {
    const playlistPath = join(dir, `.run${String(index)}.m3u8`)
    const outDir = join(staging, `run${String(index)}`)
    await mkdir(outDir, { recursive: true })
    const playlist = runPlaylist(run)
    await writeFile(playlistPath, playlist)
    const next =
      index + 1 < runs.length
        ? listedSegments(runPlaylist(runs[index + 1])).at(0)
        : undefined
    try {
      await remuxOne(
        ffmpegPath,
        dir,
        playlistPath,
        run.init,
        outDir,
        log,
        next == null ? undefined : await clockStartSec(dir, next)
      )
    } finally {
      await rm(playlistPath, { force: true })
    }
    remuxed.push(outDir)
  }

  const playlists: string[] = []
  const moved: MovedStretch[] = []
  let offset = 0
  let liveSec = 0
  let fileSec = 0
  const video = join(staging, VIDEO_FILE)
  for (const [index, outDir] of remuxed.entries()) {
    const media = await readFile(join(outDir, MEDIA_PLAYLIST), 'utf8')
    playlists.push(shiftByteRanges(media, offset))
    liveSec += lengthSec(runPlaylist(runs[index]))
    fileSec += lengthSec(media)
    const byMs = Math.round((fileSec - liveSec) * 1000)
    if (index + 1 < remuxed.length && byMs >= MOVED_AT_LEAST_MS) {
      moved.push({ fromMs: Math.round(liveSec * 1000), byMs })
    }
    const file = join(outDir, VIDEO_FILE)
    offset += (await stat(file)).size
    await pipeline(
      createReadStream(file),
      createWriteStream(video, { flags: 'a' })
    )
  }
  await writeFile(join(staging, MEDIA_PLAYLIST), joinMediaPlaylists(playlists))
  const masters: string[] = []
  for (const outDir of remuxed) {
    masters.push(await readFile(join(outDir, MASTER_PLAYLIST), 'utf8'))
  }
  const master = combinedMaster(masters)
  await writeFile(join(staging, MASTER_PLAYLIST), master)
  for (const outDir of remuxed) {
    await rm(outDir, { recursive: true, force: true })
  }
  return { largest: masterPictureSize(master), moved }
}

/** A wall-clock point is only good to about a second, so no less moves one. */
const MOVED_AT_LEAST_MS = 1000

/** The sum of a media playlist's segment lengths. */
function lengthSec(playlist: string): number {
  return playlist
    .split('\n')
    .filter(line => line.startsWith('#EXTINF:'))
    .reduce(
      (sum, line) => sum + Number.parseFloat(line.slice('#EXTINF:'.length)),
      0
    )
}

export interface PictureSize {
  width: number
  height: number
}

/** `1920x1080` as a size, or nothing. */
function sizeOf(resolution: string | undefined): PictureSize | undefined {
  const parts = /^(\d+)x(\d+)$/.exec(resolution ?? '')
  return parts == null
    ? undefined
    : { width: Number(parts[1]), height: Number(parts[2]) }
}

const STREAM_INF = '#EXT-X-STREAM-INF:'

/** The picture a master playlist says its variant has, or nothing. */
export function masterPictureSize(master: string): PictureSize | undefined {
  return sizeOf(variantOf(master).get('RESOLUTION'))
}

/** The attributes of a master playlist's variant, in their order. */
function variantOf(master: string): Map<string, string> {
  const line = master.split('\n').find(one => one.startsWith(STREAM_INF))
  const attributes = new Map<string, string>()
  for (const found of (line ?? '')
    .slice(STREAM_INF.length)
    .matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    attributes.set(found[1], found[2])
  }
  return attributes
}

/**
 * How much a video codec asks of its decoder: an HEVC tier and level
 * (`hvc1.1.6.H120.90` is High tier, level 4), or an H.264 level. A decoder
 * for one decodes everything below it.
 */
function videoLevel(codec: string): number | undefined {
  const hevc = /^(hvc1|hev1)\.[^.]*\.[^.]*\.([LH])(\d+)/.exec(codec)
  if (hevc != null) return (hevc[2] === 'H' ? 1000 : 0) + Number(hevc[3])
  const avc = /^(avc1|avc3)\.[0-9a-fA-F]{4}([0-9a-fA-F]{2})$/.exec(codec)
  if (avc != null) return Number.parseInt(avc[2], 16)
  return undefined
}

/**
 * One master playlist for a recording whose runs differ.
 *
 * Its one variant carries every run, and a player decides from it whether it
 * can play the recording at all (`CODECS`) and what it costs (`RESOLUTION`,
 * `BANDWIDTH`), so each says the most any run needs: the video codec of the
 * highest level, every other codec any run has, the largest picture and the
 * highest rates. The first run's said only what its own part needs, which
 * advertised a 720p recording that goes on at 1080p and a higher level as the
 * 720p one. The rest of the playlist is the first run's.
 */
export function combinedMaster(masters: readonly string[]): string {
  const variants = masters.map(variantOf)
  const merged = new Map(variants[0])
  const most = (name: string): void => {
    const values = variants
      .map(one => Number(one.get(name)))
      .filter(value => Number.isFinite(value))
    if (values.length > 0) merged.set(name, String(Math.max(...values)))
  }
  most('BANDWIDTH')
  most('AVERAGE-BANDWIDTH')
  most('FRAME-RATE')
  const sizes = variants
    .map(one => sizeOf(one.get('RESOLUTION')))
    .filter(size => size != null)
  if (sizes.length > 0) {
    const largest = sizes.reduce((best, size) =>
      size.width * size.height > best.width * best.height ? size : best
    )
    merged.set(
      'RESOLUTION',
      `${String(largest.width)}x${String(largest.height)}`
    )
  }
  const codecs = variants.flatMap(one =>
    (one.get('CODECS') ?? '')
      .replace(/"/g, '')
      .split(',')
      .filter(codec => codec !== '')
  )
  if (codecs.length > 0) {
    const leveled = codecs.filter(codec => videoLevel(codec) != null)
    const video = leveled.reduce<string | undefined>(
      (best, codec) =>
        best == null || videoLevel(codec)! > videoLevel(best)! ? codec : best,
      undefined
    )
    const rest = [...new Set(codecs.filter(codec => videoLevel(codec) == null))]
    merged.set(
      'CODECS',
      `"${[...(video == null ? [] : [video]), ...rest].join(',')}"`
    )
  }
  const line = `${STREAM_INF}${[...merged]
    .map(([name, value]) => `${name}=${value}`)
    .join(',')}`
  return masters[0]
    .split('\n')
    .map(one => (one.startsWith(STREAM_INF) ? line : one))
    .join('\n')
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
  initName: string = FIRST_INIT,
  joinAt?: number
): Promise<{ source: string; unfilled?: string }> {
  const asIs = { source: playlistPath }
  const playlist = await readFile(playlistPath, 'utf8').catch(() => '')
  const listed = listedSegments(playlist)
  if (listed.length < (joinAt == null ? 2 : 1)) return asIs
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
  // The gap up to the next configuration, as if that were one more segment.
  const last = pieces[pieces.length - 1]
  const atJoin = joinAt == null ? [] : [{ start: joinAt, duration: 0 }]
  const gapAtJoin = timelineHole([last, ...atJoin])
  if (!timelineHole(pieces) && !gapAtJoin) return asIs

  const scratch = join(dir, '.holes')
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const initPath = join(dir, initName)
  const isHole = (index: number): boolean =>
    index + 1 < pieces.length
      ? timelineHole([pieces[index], pieces[index + 1]])
      : gapAtJoin
  let lines: string[] | undefined
  try {
    const filled = await fillHoles(
      ffmpegPath,
      initPath,
      pieces,
      isHole,
      scratch,
      gapAtJoin ? joinAt : undefined
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
