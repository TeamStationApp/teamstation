import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

/**
 * A recording arriving from GS Director, in parts.
 *
 * **Why parts.** The take is the whole game — two hours, several gigabytes —
 * and it leaves from a ball field, over whatever network the field has. One
 * long PUT that has to start again from nought when the network blinks is a
 * PUT that never finishes. So the file arrives in pieces, each one small
 * enough to lose without grief, and the Director asks what landed before
 * sending any more. A killed app resumes; it does not restart.
 *
 * **Why the directory is the truth.** What has arrived is what is on disk, so
 * that is what is counted. A tally kept only in the database drifts from the
 * files the moment a write fails half way, and the direction it drifts is the
 * dangerous one: the server believing it holds a part it does not, and
 * assembling a recording with a hole in the middle.
 */

/**
 * 32 MB.
 *
 * Small enough that losing one to a dropped connection costs seconds, large
 * enough that a nine-gigabyte take is about 280 requests rather than 1,100.
 */
export const PART_SIZE = 32 * 1024 * 1024

/** How long a replaced recording stays before it is deleted for good. */
export const PURGE_AFTER_DAYS = 30

/** How many parts a file of this size arrives in. */
export function partCount(sizeBytes: number, partSize = PART_SIZE): number {
  if (sizeBytes <= 0 || partSize <= 0) return 0
  return Math.ceil(sizeBytes / partSize)
}

/** How many bytes the part at this index carries — the last one is short. */
export function partBytes(
  index: number,
  sizeBytes: number,
  partSize = PART_SIZE
): number {
  const total = partCount(sizeBytes, partSize)
  if (index < 0 || index >= total) return 0
  const start = index * partSize
  return Math.min(partSize, sizeBytes - start)
}

/** The parts that have not arrived, in the order to ask for them. */
export function missingParts(received: number[], total: number): number[] {
  const have = new Set(received)
  const out: number[] = []
  for (let index = 0; index < total; index++) {
    if (!have.has(index)) out.push(index)
  }
  return out
}

/** Every part, and no part twice. */
export function isComplete(received: number[], total: number): boolean {
  if (total === 0) return false
  return missingParts(received, total).length === 0
}

/**
 * When a recording that has been replaced may be deleted.
 *
 * Thirty days: long enough that a mistake — the wrong game, a bad export — has
 * a month to be noticed while the original is still there, and short enough
 * that the Space is not paid indefinitely for a copy on no page.
 */
export function purgeDateFor(now: Date): Date {
  return new Date(now.getTime() + PURGE_AFTER_DAYS * 24 * 3600 * 1000)
}

/**
 * Which of a game's recordings the upload takes the place of.
 *
 * The live stream of that game, and only that: it is the same rig filming the
 * same game, and the upload has none of the losses the field's uplink added.
 * Anything else the game holds — a camera, a composite, an earlier upload — is
 * left alone, because replacing something is a claim about what a recording
 * *is*, and the only thing this upload is certainly a better copy of is the
 * stream it was recorded alongside.
 *
 * **And only if it actually covers it.** The claim is "a better copy of the
 * same game", which a recording that is minutes long when the stream is hours
 * long is plainly not. A 107-second bench clip uploaded to a game hid its
 * two-hour live recording and dated it for deletion, which is the whole of
 * that game gone from the page in exchange for a clip. So the upload has to
 * be about as long as what it displaces — shorter by a couple of minutes is
 * ordinary, since a stream is usually started after the recording and stopped
 * before it, but shorter by an hour is a different recording.
 *
 * A recording already hidden is not touched: it is not in anybody's way, and
 * giving it a fresh purge date would restart a clock that may be nearly up.
 * A live recording whose length is unknown is left alone too — with nothing to
 * compare, there is no evidence the upload covers it.
 */
export const COVERAGE_TOLERANCE_SEC = 120

export function liveToReplace(
  videos: Array<{
    id: string
    kind: string
    hidden: boolean
    durationSec?: number | null
  }>,
  uploadedId: string,
  uploadedSeconds?: number | null
): string[] {
  return videos
    .filter(one => one.id !== uploadedId && one.kind === 'live' && !one.hidden)
    .filter(one => covers(uploadedSeconds, one.durationSec))
    .map(one => one.id)
}

/** Whether an upload of this length can be said to cover that recording. */
export function covers(
  uploadedSeconds: number | null | undefined,
  liveSeconds: number | null | undefined
): boolean {
  // Nothing to compare: an upload that does not know its own length, or a
  // live recording that does not know its. Both are unusual, and neither is
  // evidence of covering anything.
  if (uploadedSeconds == null || liveSeconds == null) return false
  if (uploadedSeconds <= 0 || liveSeconds <= 0) return false
  return uploadedSeconds + COVERAGE_TOLERANCE_SEC >= liveSeconds
}

/**
 * When the recording an upload carries began, out of what an app sent.
 *
 * Refused rather than guessed at when it is not a real instant: a wrong
 * `start_at` is worse than none, because the library will happily lay a
 * take's cameras out against it. Null then means "the app did not say", and
 * `startOf` picks the game's own time instead.
 *
 * A year either side of now is the sanity bound. Not tighter: a take sitting
 * on an iPad for a fortnight before anybody uploads it is ordinary, and so is
 * a season's archive going up months later.
 */
export function recordingStart(
  text: string | undefined,
  now = new Date()
): Date | null {
  if (text == null || text.trim() === '') return null
  const when = new Date(text)
  if (Number.isNaN(when.getTime())) return null
  const year = 365 * 24 * 3600 * 1000
  if (Math.abs(when.getTime() - now.getTime()) > year) return null
  return when
}

/**
 * The instant a finished upload's video is placed at.
 *
 * What the app said when it opened the upload, and failing that the game's
 * own start. **Never when the upload was opened**: that is a fact about the
 * network, not about the recording, and using it put the two cameras of one
 * take thirty-four minutes apart in the multi-camera view — precisely how
 * long the first file had taken to send.
 */
export function startOf(started: Date | string | null, gameStart: Date): Date {
  if (started == null) return gameStart
  const when = started instanceof Date ? started : new Date(started)
  return Number.isNaN(when.getTime()) ? gameStart : when
}

/**
 * What to tell an operator about a conversion that failed.
 *
 * ffmpeg and ffprobe say what went wrong in a sentence and then say where
 * everything is: absolute paths inside the server, the whole command line,
 * build flags. All of that went to the app and on to the screen, which tells
 * somebody standing at a ball field nothing they can act on and tells anyone
 * with an account the shape of the server's disk.
 *
 * So: the line that actually says something, with anything path-shaped taken
 * out of it. **Not simply the first line** — ffmpeg's first line is the
 * command it ran, so taking that left a redacted command line on the screen
 * and dropped "Invalid data found when processing input" onto the floor. The
 * whole of it is still in the server's log, where whoever is fixing it can
 * read it.
 */
export function failureToShow(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const lines = raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  // A line that is mostly the invocation tells nobody anything.
  const said =
    lines.find(line => !/^(command|ffmpeg|ffprobe)\b/i.test(line)) ??
    lines[0] ??
    raw
  const withoutPaths = said
    .replace(/(\/[\w.+-]+){2,}/g, 'a file')
    .replace(/\s+/g, ' ')
    .trim()
  const short = withoutPaths.slice(0, 200)
  return short === '' ? 'That recording could not be taken in.' : short
}

/** Where an upload's parts are kept while it is arriving. */
export function uploadDir(uploadsDir: string, uploadId: string): string {
  return join(uploadsDir, uploadId)
}

/** `part-000007`, so a directory listing sorts into sending order. */
export function partName(index: number): string {
  return `part-${String(index).padStart(6, '0')}`
}

export function partIndexOf(name: string): number | null {
  const match = /^part-(\d{6})$/.exec(name)
  return match == null ? null : Number(match[1])
}

/** The part indexes on disk, lowest first. */
export async function receivedParts(dir: string): Promise<number[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: number[] = []
  for (const name of names) {
    const index = partIndexOf(name)
    if (index != null) out.push(index)
  }
  return out.sort((a, b) => a - b)
}

/** What has arrived, in bytes, counted off the files themselves. */
export async function receivedBytes(dir: string): Promise<number> {
  const parts = await receivedParts(dir)
  let total = 0
  for (const index of parts) {
    try {
      total += (await stat(join(dir, partName(index)))).size
    } catch {
      // Gone between the listing and the look: it did not arrive.
    }
  }
  return total
}

/**
 * The parts, in order, into one file.
 *
 * Streamed rather than read: the whole point is that this is bigger than the
 * machine wants in memory.
 */
export async function assembleParts(options: {
  dir: string
  total: number
  into: string
}): Promise<number> {
  const { dir, total, into } = options
  const received = await receivedParts(dir)
  if (!isComplete(received, total)) {
    throw new Error(
      `cannot assemble: ${missingParts(received, total).length} parts missing`
    )
  }
  const out = createWriteStream(into)
  // `pipeline` adds its own error, close, finish and end listeners to the
  // destination every time it is called, and with `end: false` the
  // destination outlives the call — so 113 parts is 113 sets of listeners on
  // one stream, which Node warns about at eleven and which is a real leak on
  // a longer take. Lifting the cap for the span of the assembly is the honest
  // fix: the listeners are wanted, there are simply many of them.
  const ceiling = out.getMaxListeners()
  out.setMaxListeners(total + 10)
  try {
    for (let index = 0; index < total; index++) {
      await pipeline(createReadStream(join(dir, partName(index))), out, {
        end: false
      })
    }
  } finally {
    out.setMaxListeners(ceiling)
    out.end()
  }
  return (await stat(into)).size
}

export async function ensureUploadDir(
  uploadsDir: string,
  uploadId: string
): Promise<string> {
  const dir = uploadDir(uploadsDir, uploadId)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Uploads a stopped server left half-taken-in.
 *
 * Taking an upload in happens behind the request that asked for it, so a
 * deploy or a crash in the middle leaves a row saying `assembling` with
 * nothing assembling it. Nothing else will ever move that row, and an app
 * polling it waits for ever.
 *
 * They go back to `open` rather than `failed`, because that is what they
 * are: every part is still on disk, so asking to finish again costs the
 * conversion and not the upload. The same reasoning as the live controller
 * resetting `publishing` streams on the way up — a fresh process cannot be
 * doing work the last one claimed.
 */
export async function reopenInterruptedUploads(
  db: Kysely<Database>
): Promise<number> {
  const reopened = await db
    .updateTable('director_uploads')
    .set({
      state: 'open',
      step: null,
      message: 'The server restarted while this was being taken in.',
      updated_at: new Date()
    })
    .where('state', '=', 'assembling')
    .executeTakeFirst()
  return Number(reopened.numUpdatedRows ?? 0)
}
