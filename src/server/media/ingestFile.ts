import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import type { Database, VideosTable } from '../db/database'
import {
  AAC_PRIMING_SAMPLES,
  MASTER_PLAYLIST,
  MEDIA_PLAYLIST,
  probeDuration,
  remuxToHls,
  VIDEO_FILE
} from './ffmpeg'
import type { SpaceSettings } from './spacesHls'
import {
  deleteVideoFromSpace,
  uploadVideoDirectory,
  verifyVideoDirectory
} from './spacesVideo'

const run = promisify(execFile)

/**
 * A finished recording becomes a video in the library.
 *
 * One sequence, used by everything that has a whole file to put in: the side
 * import that reads the archive, and the upload endpoint TS Director
 * sends its takes to. The live path is deliberately not this — it writes its
 * HLS as the game happens and has no file to hand — but it ends in the same
 * place, and the order here is the order it proved out:
 *
 * 1. **Read the file.** Codec, shape and the length it really is rather than
 *    the length something claimed.
 * 2. **Remux to HLS**, never re-encode, with the tag the codec actually wants.
 * 3. **Copy to the Space**, and **verify every object is there**.
 * 4. **Only then write the row.** A row for an object that is not in the
 *    Space is worse than no row at all: the library says a game has a
 *    recording, and every page that offers it fails.
 */

export interface ProbedFile {
  codecName: string
  width: number
  height: number
  /**
   * How long the remux is expected to run — the file's own length **plus its
   * pre-roll**, because the copy keeps what the edit list says to skip.
   *
   * A prediction, and only ever used as one: what goes on the row is the
   * finished playlist's own length, read back after the remux. They agree to
   * a few milliseconds on every real recording, and a file whose streams
   * start at different positive times can part them by a second.
   */
  durationSec: number
  hasAudio: boolean
  /**
   * The pre-roll at the head of the file, in seconds, and zero for a file
   * that has none. **Negative** where the file's own timeline starts late,
   * which pulls the copy forward instead.
   *
   * An AVFoundation export writes an edit list: its tracks hold a little more
   * than the take does, and the `elst` says where the take actually begins.
   * A track with B-frames adds a frame or two of its own, because it decodes
   * before it presents. Neither survives into HLS fMP4, so `-c copy` cannot
   * honour them — FFmpeg instead shifts every stream up until the earliest
   * decodes at zero, which keeps sound and picture together and moves the
   * *whole recording* later by that much.
   *
   * That is invisible in one video and wrong in several: each file's pre-roll
   * is its own length, so two angles of the same half-inning land offset from
   * each other by the difference. Half a second between a programme master
   * and its cameras on the measured export — five times the tolerance the
   * angle grid lines up to.
   */
  preRollSec: number
  /**
   * AAC priming the file's sound starts with and does not declare, in
   * samples: `AAC_PRIMING_SAMPLES` for an AAC-LC track whose priming nobody
   * wrote down, 0 for everything else. The remux stamps those samples before
   * zero, as it already does for priming a file declares.
   *
   * Every take TS Director and TS Distributor send is such a file. AVFoundation
   * skips the priming when it plays one; FFmpeg did not, so the copy in the
   * Space had its sound 44 ms behind where the iPad and the Mac play it.
   */
  soundPrimingSamples: number
}

/**
 * The tag the track must keep.
 *
 * HEVC needs `hvc1` or Safari refuses it. H.264 must stay `avc1`: a track
 * tagged as a codec it is not plays nowhere at all. Anything else is left
 * alone rather than guessed at.
 */
export function tagFor(codecName: string): string | null {
  if (codecName === 'hevc' || codecName === 'h265') return 'hvc1'
  if (codecName === 'h264' || codecName === 'avc1') return 'avc1'
  return null
}

/** `…/bin/ffmpeg` → `…/bin/ffprobe`, which ships beside it. */
export function ffprobeBeside(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg$/, 'ffprobe')
}

/**
 * Takes a half-made video's objects back out of the Space.
 *
 * Best effort by design: the caller is about to throw the reason this is
 * happening, and that reason is what anybody needs to hear. A delete that
 * also fails would bury it.
 */
async function forgetTheCopy(
  space: SpaceSettings,
  videoId: string
): Promise<void> {
  try {
    await deleteVideoFromSpace({ space, videoId })
  } catch {
    // Nothing further can be done from here.
  }
}

export async function probeVideoFile(
  ffmpegPath: string,
  file: string
): Promise<ProbedFile> {
  const { stdout } = await run(ffprobeBeside(ffmpegPath), [
    '-v',
    'error',
    // The first packets, to see the pre-roll. An edit list shows up as a
    // negative timestamp on the stream it trims, and the deepest of them is
    // exactly how far the remux will move the recording. Sixty-four is enough
    // to have met every track: an MP4 interleaves, so each one's first packet
    // is at the head of the file, and reading this many costs one seek.
    '-read_intervals',
    '%+#64',
    '-show_entries',
    'packet=stream_index,dts_time',
    '-show_entries',
    'stream=index,codec_type,codec_name,profile,sample_rate,initial_padding,width,height',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    file
  ])
  return readProbe(stdout, file)
}

/**
 * How far back the earliest packet **decodes**, which is how far forward the
 * remux will push everything.
 *
 * The earliest **per stream**, then the earliest of those: sound and picture
 * are trimmed by different amounts — 0.500 s and 0.022 s on the export this
 * was measured from — and FFmpeg shifts by the deeper of the two, taking the
 * other along with it so they stay in step with each other.
 *
 * **Decode time, not presentation time**, because decode time is what the
 * muxer's `avoid_negative_ts make_zero` reads: it puts the first DTS at zero
 * and carries every PTS along by the same amount. A track with B-frames
 * decodes its first frames before it presents them, so a camera archive with
 * no edit list at all still starts one frame back and its copy really does
 * present a frame late. Measuring presentation time here reads zero for those
 * and leaves them 33 ms behind — 67 ms on a three-B-frame encode — which is
 * inside the grid's tolerance and still not where they were filmed.
 *
 * A file with nothing negative in it answers zero, which is the same as not
 * doing this at all.
 */
export function preRollFrom(
  packets: Array<{ stream_index?: number; dts_time?: string }>,
  /** Seconds the remux will additionally move a stream back, by index. */
  movedBack = new Map<number, number>()
): number {
  const earliest = new Map<number, number>()
  for (const packet of packets) {
    const at = Number(packet.dts_time)
    if (!Number.isFinite(at)) continue
    const stream = packet.stream_index ?? 0
    const moved = at - (movedBack.get(stream) ?? 0)
    const seen = earliest.get(stream)
    if (seen == null || moved < seen) earliest.set(stream, moved)
  }
  const first = Math.min(...earliest.values())
  // Not clamped at zero. `make_zero` puts the first timestamp at zero whatever
  // its sign, so a file whose own timeline starts *late* is pulled forward by
  // that much and its copy begins earlier than the file did. Refusing to see
  // that was the same fault as finding 28 from the other side of zero: a
  // source whose streams start at different positive times holds half a second
  // of nothing before its first picture, and the row claimed that picture was
  // at media time zero.
  return Number.isFinite(first) ? -first : 0
}

/** The shape `ffprobe -of json` answers with, read into what this needs. */
export function readProbe(stdout: string, file: string): ProbedFile {
  const parsed = JSON.parse(stdout) as {
    streams?: ProbedStreamJson[]
    packets?: Array<{ stream_index?: number; dts_time?: string }>
    format?: { duration?: string }
  }
  const streams = parsed.streams ?? []
  const video = streams.find(one => one.codec_type === 'video')
  if (video?.codec_name == null) throw new Error(`no video stream in ${file}`)
  // The sound the remux keeps is the first; its undeclared priming moves it
  // back, which can make it the deepest stream of all.
  const sound = streams.find(one => one.codec_type === 'audio')
  const soundPrimingSamples = undeclaredPriming(sound)
  const movedBack = new Map<number, number>()
  if (soundPrimingSamples > 0 && sound?.index != null) {
    movedBack.set(sound.index, soundPrimingSamples / Number(sound.sample_rate))
  }
  const preRollSec = preRollFrom(parsed.packets ?? [], movedBack)
  return {
    codecName: video.codec_name,
    width: video.width ?? 0,
    height: video.height ?? 0,
    // `format=duration` is the length the edit list presents, and the remux
    // does not apply the edit list — so what ends up in the Space, and what
    // the player will scrub through, is this much longer.
    durationSec: Math.round(Number(parsed.format?.duration ?? 0) + preRollSec),
    hasAudio: sound != null,
    preRollSec,
    soundPrimingSamples
  }
}

interface ProbedStreamJson {
  index?: number
  codec_type?: string
  codec_name?: string
  profile?: string
  sample_rate?: string
  initial_padding?: number
  width?: number
  height?: number
}

/**
 * The AAC priming a sound track starts with and does not declare.
 *
 * FFmpeg reports a declared priming as `initial_padding`. AAC-LC with none
 * declared gets the delay Apple's encoders write, which is also what
 * AVFoundation assumes when it plays the file. Any other codec, or a profile
 * whose delay is not that, is left as the file says.
 */
export function undeclaredPriming(
  stream: ProbedStreamJson | undefined
): number {
  if (stream?.codec_name !== 'aac' || stream.profile !== 'LC') return 0
  if ((stream.initial_padding ?? 0) !== 0) return 0
  if (!(Number(stream.sample_rate) > 0)) return 0
  return AAC_PRIMING_SAMPLES
}

export interface IngestOptions {
  db: Kysely<Database>
  space: SpaceSettings
  ffmpegPath: string
  /** The whole recording, on this machine. */
  file: string
  gameId: string
  kind: VideosTable['kind']
  title: string
  /**
   * When the recording's **own timeline** begins — not the instant the upload
   * started, and not the instant of the first picture either. The two are the
   * same on every recording either app sends, because the take starts when
   * the camera does; they part on a file that holds a gap before its first
   * frame, and then it is the container's zero that the game's clock is hung
   * from.
   *
   * The pre-roll is taken off this before it is stored, so what the row says
   * is when **media time zero of the remux** happened. See `preRollSec`.
   */
  startAt: Date
  startAtSource: NonNullable<VideosTable['start_at_source']>
  /** Given where the caller minted one already, so it can be reported first. */
  videoId?: string
  numCameras?: number
  /** Told what is happening, for a caller with somebody watching a progress bar. */
  onStep?: (step: 'probing' | 'remuxing' | 'uploading' | 'writing') => void
}

export interface Ingested {
  videoId: string
  bytes: number
  probed: ProbedFile
}

export async function ingestVideoFile(
  options: IngestOptions
): Promise<Ingested> {
  const {
    db,
    space,
    ffmpegPath,
    file,
    gameId,
    kind,
    title,
    startAt,
    startAtSource,
    videoId = makeId('video'),
    numCameras = 1,
    onStep
  } = options

  onStep?.('probing')
  const probed = await probeVideoFile(ffmpegPath, file)

  // The row has to say when media time zero happened, because that is the
  // only thing the multi-camera grid can line two angles up by. The remux
  // keeps the file's pre-roll, so media time zero is the caller's instant
  // *less* that pre-roll — and every angle's pre-roll is its own length, so
  // leaving this out is what put two cameras of the same half-inning half a
  // second apart.
  const firstFrameAt = new Date(
    startAt.getTime() - Math.round(probed.preRollSec * 1000)
  )

  const work = await mkdtemp(join(tmpdir(), `tsIngest-${videoId}-`))
  try {
    // Before anything is moved: a database that cannot be reached at the end
    // has already cost however long the remux and the copy took.
    await db.selectFrom('videos').select('id').limit(1).execute()

    onStep?.('remuxing')
    await remuxToHls(ffmpegPath, {
      input: file,
      outDir: work,
      videoTag: tagFor(probed.codecName),
      soundPrimingSamples: probed.soundPrimingSamples
    })

    // How long it runs, read back off what was written rather than worked
    // out from what went in. Predicting it means predicting the muxer, and
    // the muxer is the thing this whole path has been wrong about twice.
    const durationSec = Math.round(
      await probeDuration(ffprobeBeside(ffmpegPath), join(work, MEDIA_PLAYLIST))
    )

    onStep?.('uploading')
    const files = [MASTER_PLAYLIST, MEDIA_PLAYLIST, VIDEO_FILE]
    // From the first byte copied to the row being written, this video's
    // objects exist with nothing pointing at them. Anything that goes wrong
    // in between has to take them back out: a copy that failed half way
    // leaves playlists with no film beside them, which no query can find and
    // the Space charges for anyway. One such pair is in the bucket from
    // before this existed.
    let uploaded: Awaited<ReturnType<typeof uploadVideoDirectory>>
    try {
      uploaded = await uploadVideoDirectory({
        space,
        videoId,
        dir: work,
        files
      })
      const verified = await verifyVideoDirectory({
        space,
        videoId,
        dir: work,
        files: uploaded.files
      })
      if (!verified.ok) {
        throw new Error(`the Space did not verify: ${verified.reason}`)
      }
    } catch (error) {
      await forgetTheCopy(space, videoId)
      throw error
    }

    onStep?.('writing')
    const now = new Date()
    // From here the objects exist and nothing points at them yet. If the row
    // will not be written — a game deleted while the conversion ran, a
    // database that has gone away — they have to be taken back out, or they
    // are paid for for ever with nothing able to find them. Copies nobody can
    // see are the failure this whole path was written to avoid.
    try {
      await db
        .insertInto('videos')
        .values({
          id: videoId,
          game_id: gameId,
          kind,
          title,
          storage: 'spaces',
          status: 'ready',
          start_at: firstFrameAt,
          start_at_source: startAtSource,
          duration_sec: durationSec,
          width: probed.width,
          height: probed.height,
          // The same tag the track carries and the same value the live path
          // records, so an uploaded recording and a streamed one describe
          // themselves the same way. Null for a codec `tagFor` will not vouch
          // for, rather than a guess.
          codecs: tagFor(probed.codecName),
          num_cameras: numCameras,
          hidden: false,
          size_bytes: String(uploaded.bytes),
          spaces_verified_at: now,
          created_at: now,
          updated_at: now
        })
        .execute()
    } catch (error) {
      await forgetTheCopy(space, videoId)
      throw error
    }

    return {
      videoId,
      bytes: uploaded.bytes,
      probed: { ...probed, durationSec }
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
