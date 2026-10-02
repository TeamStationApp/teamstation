import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * When a recording started, read out of the file itself.
 *
 * This is the hardest thing about accepting a video from somebody. Every
 * highlight is placed by subtracting the video's start from the play's wall
 * clock, so an hour's error moves every thumbnail and every seek point, and
 * `computeHighlights` quietly drops the plays that fall outside. Four imported
 * videos were two hours late once and lost every highlight they had.
 *
 * So this module reads, and reports **how much it is worth believing**. It
 * never decides. What a container has to say about its own age ranges from
 * authoritative to actively misleading, and the caller is expected to put a
 * human or a play stream in front of the answer before placing a video on the
 * timeline.
 *
 * What was measured, against the pinned FFmpeg 9.0.1 and real files:
 *
 * - `-c copy` **drops** `creation_time` unless `-map_metadata 0` is given.
 *   Re-encoding drops it. Our own HLS remux drops it, which is why the real
 *   two-hour game recording on the server carries no creation time at all, and
 *   why this has to be read from the **original upload, before anything
 *   touches it**, and stored. Reading it back off stored HLS will never work.
 * - MP4's `mvhd` field is an instant — seconds since 1904 UTC — and cannot
 *   carry an offset. Supply one and FFmpeg absorbs it correctly. The danger is
 *   the muxer that writes **local wall-clock time into that UTC field**, which
 *   many do, and nothing in the file admits to it: a video that says
 *   `16:43:08Z` may mean `16:43:08` Pacific. That is the seven-hour error that
 *   looks exactly like a right answer, and the reason `creation_time` alone is
 *   only ever `low` confidence.
 * - Apple writes `com.apple.quicktime.creationdate` with a real UTC offset,
 *   which is unambiguous and is preferred here when present. FFmpeg will not
 *   write that tag, so it could not be round-tripped in testing — treat the
 *   `high` confidence on it as expected rather than proven until it has been
 *   checked against one real iPhone recording.
 */

/** Where a start time came from, in descending order of how much it is worth. */
export type StartTimeSource =
  /** The uploader said so. GS Director knows: it started the clock. */
  | 'stated'
  /** `com.apple.quicktime.creationdate` — carries a real UTC offset. */
  | 'metadataOffset'
  /** `mvhd` `creation_time` — an instant, possibly local time mislabelled. */
  | 'metadata'

export type StartTimeConfidence = 'high' | 'low'

export interface StartTimeFinding {
  at: Date
  source: StartTimeSource
  confidence: StartTimeConfidence
  /**
   * Whether a person should be made to look at this before it is used.
   *
   * `true` for everything that could silently be out by a timezone. The cost
   * of asking is one glance at a filled-in field; the cost of not asking is a
   * game whose every highlight is an hour from the play it names.
   */
  needsConfirming: boolean
  /** What the tag actually said, for showing in the confirm step. */
  raw: string
}

export interface ProbedFile {
  /** `undefined` when the file says nothing about its own age. */
  start?: StartTimeFinding
  durationSec?: number
  width?: number
  height?: number
  codecName?: string
  codecTag?: string
  /** Every tag read, so a file that surprises us can be diagnosed later. */
  tags: Record<string, string>
}

/** The tag Apple writes, which is the only one that carries its own offset. */
const APPLE_TAG = 'com.apple.quicktime.creationdate'

/**
 * Everything a fresh upload can be asked about itself.
 *
 * One `ffprobe`, because a caller wants the start time and the dimensions at
 * the same moment and the file may be several gigabytes on a cold disk.
 */
export async function probeUpload(
  ffprobePath: string,
  file: string
): Promise<ProbedFile> {
  const { stdout } = await run(
    ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:format_tags:stream=codec_name,codec_tag_string,width,height:stream_tags',
      '-select_streams',
      'v:0',
      '-of',
      'json',
      file
    ],
    { maxBuffer: 1 << 22 }
  )
  return readProbe(stdout)
}

interface RawProbe {
  format?: { duration?: string; tags?: Record<string, string> }
  streams?: Array<{
    codec_name?: string
    codec_tag_string?: string
    width?: number
    height?: number
    tags?: Record<string, string>
  }>
}

/**
 * The parsing, apart from the process, so it can be tested against the output
 * of files we do not have on this machine.
 */
export function readProbe(stdout: string): ProbedFile {
  let parsed: RawProbe
  try {
    parsed = JSON.parse(stdout) as RawProbe
  } catch {
    return { tags: {} }
  }

  const stream = parsed.streams?.[0]
  // Stream tags first so a format tag of the same name wins: the container's
  // answer is the one FFmpeg itself reports for the file as a whole.
  const tags: Record<string, string> = {
    ...(stream?.tags ?? {}),
    ...(parsed.format?.tags ?? {})
  }

  const duration = Number.parseFloat(parsed.format?.duration ?? '')

  return {
    start: startFrom(tags),
    durationSec: Number.isFinite(duration) ? duration : undefined,
    width: stream?.width,
    height: stream?.height,
    codecName: stream?.codec_name,
    codecTag: stream?.codec_tag_string,
    tags
  }
}

/** The best the tags can do, and how much it is worth. */
export function startFrom(
  tags: Record<string, string>
): StartTimeFinding | undefined {
  const apple = findTag(tags, APPLE_TAG)
  if (apple != null) {
    const at = parseStamp(apple)
    // Only worth its higher standing if it actually carries the offset that
    // makes it unambiguous. Apple writes one; a copy that lost it is no better
    // than `creation_time`.
    if (at != null && hasOffset(apple)) {
      return {
        at,
        source: 'metadataOffset',
        confidence: 'high',
        needsConfirming: false,
        raw: apple
      }
    }
  }

  const created = findTag(tags, 'creation_time')
  if (created != null) {
    const at = parseStamp(created)
    if (at != null) {
      return {
        at,
        source: 'metadata',
        // Never high, however well-formed it looks. The failure this guards
        // against is a correct-looking UTC stamp that was local time.
        confidence: 'low',
        needsConfirming: true,
        raw: created
      }
    }
  }

  return undefined
}

/** Tag names vary in case between muxers; nothing else about them varies. */
function findTag(
  tags: Record<string, string>,
  name: string
): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() === wanted && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Whether the text states its own offset, rather than leaving it to be guessed. */
export function hasOffset(stamp: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp.trim())
}

/**
 * A timestamp, or nothing.
 *
 * Muxers that have no answer tend to write a placeholder rather than leaving
 * the field out — the 1904 epoch, or the Unix one — and a video recorded in
 * 1904 is not a thing to place on a timeline. Those are refused here rather
 * than passed on as a finding somebody has to recognise further down.
 */
export function parseStamp(stamp: string): Date | undefined {
  const text = stamp.trim()
  if (text === '') return undefined

  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return undefined

  const at = new Date(ms)
  const year = at.getUTCFullYear()
  if (year < 2000 || year > 2100) return undefined
  return at
}
