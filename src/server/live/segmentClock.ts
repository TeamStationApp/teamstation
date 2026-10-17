import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync
} from 'fs'
import { open } from 'fs/promises'

import { readTracks } from '../media/trackStarts'
import {
  fragmentSamples,
  readBoxes,
  stampOfSample,
  videoTrackOf
} from '../media/wallClockScan'

interface LocatedBox {
  type: string
  start: number
  size: number
  payload: number
}

/** Boxes in [from, to). Stops at the first box that does not fit. */
function locatedBoxes(
  buffer: Buffer,
  from: number,
  to: number
): { boxes: LocatedBox[]; end: number } {
  const boxes: LocatedBox[] = []
  let at = from
  while (at + 8 <= to) {
    let size = buffer.readUInt32BE(at)
    const type = buffer.toString('latin1', at + 4, at + 8)
    let header = 8
    if (size === 1) {
      if (at + 16 > to) break
      size = Number(buffer.readBigUInt64BE(at + 8))
      header = 16
    } else if (size === 0) {
      size = to - at
    }
    if (!Number.isFinite(size) || size < header || at + size > to) break
    boxes.push({ type, start: at, size, payload: at + header })
    at += size
  }
  return { boxes, end: at }
}

/**
 * One frame at 30 fps. A continuous segment sits about this far from the
 * length the playlist lists; a wider gap is time with no picture.
 */
export const FRAME_SLACK_SEC = 1 / 30

/** Still inside the publisher's opening composition offset. */
const PUBLISHER_ZERO_SEC = 0.25

/**
 * Behind its programme date by enough that the file cannot already be on
 * the programme clock. A placed segment's date and its timestamps disagree
 * by less than this.
 */
const CLEARLY_BEHIND_SEC = 1

function addTicks(
  buffer: Buffer,
  at: number,
  version: number,
  ticks: bigint
): void {
  const sum =
    (version === 1
      ? buffer.readBigUInt64BE(at)
      : BigInt(buffer.readUInt32BE(at))) + ticks
  if (sum < 0n) throw new Error('timeline offset moves this box before zero')
  if (version === 1) {
    buffer.writeBigUInt64BE(sum, at)
    return
  }
  if (sum > 0xffffffffn) {
    throw new Error('timeline offset does not fit this box')
  }
  buffer.writeUInt32BE(Number(sum), at)
}

/** Ticks between two timeline positions, each rounded as a stamp rounds it. */
function ticksBetween(
  fromSec: number,
  toSec: number,
  timescale: number
): bigint {
  return (
    BigInt(Math.round(toSec * timescale)) -
    BigInt(Math.round(fromSec * timescale))
  )
}

/**
 * Moves one new segment onto the programme clock.
 *
 * A publisher that returns starts its own timestamps at zero. Adding that
 * offset in the muxer rewrites `init.mp4` and shifts the segments already
 * listed onto the new time, so a player demuxing the playlist sees the
 * earlier part on top of the later one. This leaves the init segment alone
 * and adds the offset, in each box's own timescale, to this segment's `sidx`
 * earliest presentation time and to each track's `tfdt`. Undefined when the
 * segment is not a complete run of boxes yet.
 */
export function placeSegmentOnTimeline(
  init: Buffer,
  segment: Buffer,
  offsetSec: number
): Buffer | undefined {
  if (!(offsetSec > 0)) return Buffer.from(segment)
  return moveSegmentOnTimeline(init, segment, 0, offsetSec)
}

/**
 * Moves a segment already placed `fromSec` along the timeline to `toSec`
 * instead, in each box's own timescale, so it reads exactly as if it had been
 * placed at `toSec` in the first place. Undefined when the segment is not a
 * complete run of boxes yet; throws when a stamp would not fit its box or
 * would fall before zero.
 */
export function moveSegmentOnTimeline(
  init: Buffer,
  segment: Buffer,
  fromSec: number,
  toSec: number
): Buffer | undefined {
  const out = Buffer.from(segment)
  const top = locatedBoxes(out, 0, out.length)
  if (top.end !== out.length) return undefined
  const initTop = locatedBoxes(init, 0, init.length)
  const moov = initTop.boxes.find(box => box.type === 'moov')
  const timescales = new Map<number, number>()
  if (moov != null) {
    for (const [id, track] of readTracks(
      init.subarray(moov.payload, moov.start + moov.size)
    )) {
      timescales.set(id, track.timescale)
    }
  }
  for (const box of top.boxes) {
    if (box.type === 'sidx') {
      const version = out[box.payload]
      const timescale = out.readUInt32BE(box.payload + 8)
      if (timescale > 0) {
        addTicks(
          out,
          box.payload + 12,
          version,
          ticksBetween(fromSec, toSec, timescale)
        )
      }
    }
    if (box.type !== 'moof') continue
    const moof = locatedBoxes(out, box.payload, box.start + box.size)
    for (const child of moof.boxes) {
      if (child.type !== 'traf') continue
      const traf = locatedBoxes(out, child.payload, child.start + child.size)
      let timescale = 0
      const stamps: LocatedBox[] = []
      for (const field of traf.boxes) {
        if (field.type === 'tfhd' && field.payload + 8 <= out.length) {
          timescale = timescales.get(out.readUInt32BE(field.payload + 4)) ?? 0
        }
        if (field.type === 'tfdt') stamps.push(field)
      }
      if (timescale <= 0) continue
      const ticks = ticksBetween(fromSec, toSec, timescale)
      for (const stamp of stamps) {
        addTicks(out, stamp.payload + 4, out[stamp.payload], ticks)
      }
    }
  }
  return out
}

/**
 * When a segment's first picture was captured, from the wall clock it
 * carries: the wall-clock SEI (`src/common/wallClockSei.ts`) TS Director and
 * the phones put on every frame. The SEI travels with the picture through the
 * ingest, the copy into HLS and the recording, so the server reads it off the
 * segment it is about to stamp, against that picture's own place in the
 * segment, with nothing to correlate in between.
 */
export interface FrameWall {
  /** When the picture was captured, in milliseconds since 1970 on the server's clock. */
  capturedAtMs: number
  /** Where the picture sits on the segment's timeline as the segment stands, in seconds. */
  pictureSec: number
}

/**
 * The wall clock the segment's first picture carries, read from the
 * segment's opening bytes: its first `moof`, the video track's first sample,
 * and the SEI ahead of the picture in it. Undefined when that picture carries
 * none, which is every segment from a publisher that sends none, or one on
 * the publisher's own clock (the corrected bit clear): a publisher that has
 * not measured the server's clock says nothing the server's arrival does not.
 */
export function readFrameWall(
  init: Buffer,
  segment: Buffer
): FrameWall | undefined {
  const track = videoTrackOf(init)
  if (track == null) return undefined
  const moof = readBoxes(segment, 0, segment.length).find(
    box => box.type === 'moof'
  )
  if (moof == null) return undefined
  const first = fragmentSamples(segment, moof, track)[0]
  if (first == null) return undefined
  const stamp = stampOfSample(segment, first, track)
  if (stamp?.corrected !== true) return undefined
  return { capturedAtMs: stamp.wallMs, pictureSec: first.pts / track.timescale }
}

/** {@link readLeadingBoxes}, for a caller that cannot wait. */
export function readLeadingBoxesSync(path: string): Buffer {
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(LEADING_BOX_BYTES)
    const bytesRead = readSync(handle, buffer, 0, LEADING_BOX_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(handle)
  }
}

/**
 * Where a segment sits on the playlist's timeline: its first `sidx`'s
 * earliest presentation time, in that box's own timescale, as
 * `moveSegmentOnTimeline` writes it. The init segment's first track need not
 * be the one that `sidx` describes: the track order follows the ingest's
 * first packet, and a fragment with no samples of a track has no `sidx` for
 * it. A `sidx` with no timescale is read in that of the track it references.
 * Both files are read box by box. Undefined when the segment's leading boxes
 * hold no `sidx`.
 */
export function timelineStartSec(
  init: Buffer,
  segment: Buffer
): number | undefined {
  const box = locatedBoxes(segment, 0, segment.length).boxes.find(
    item => item.type === 'sidx'
  )
  if (box == null) return undefined
  const version = segment[box.payload]
  const end = box.start + box.size
  const earliestAt = box.payload + 12
  if (earliestAt + (version === 1 ? 8 : 4) > end) return undefined
  const earliest =
    version === 1
      ? segment.readBigUInt64BE(earliestAt)
      : BigInt(segment.readUInt32BE(earliestAt))
  const own = segment.readUInt32BE(box.payload + 8)
  const timescale =
    own > 0 ? own : trackTimescale(init, segment.readUInt32BE(box.payload + 4))
  if (timescale == null || timescale <= 0) return undefined
  return Number(earliest) / timescale
}

/** The timescale of one track of the init segment, by its id. */
function trackTimescale(init: Buffer, trackId: number): number | undefined {
  const moov = locatedBoxes(init, 0, init.length).boxes.find(
    box => box.type === 'moov'
  )
  if (moov == null) return undefined
  return readTracks(init.subarray(moov.payload, moov.start + moov.size)).get(
    trackId
  )?.timescale
}

function writeStamped(path: string, bytes: Buffer): void {
  const temporary = `${path}.${process.pid}.stamp`
  writeFileSync(temporary, bytes)
  renameSync(temporary, path)
}

interface ListedSegment {
  start: number
  duration: number
}

/**
 * Programme position of each listed segment, in seconds from the first
 * program date. The date applies to the segment that follows it. That
 * segment's duration may be written before the date or after it. With no
 * date, the position is the media listed before the segment.
 */
function listedProgramme(playlist: string): Map<string, ListedSegment> {
  const listed = new Map<string, ListedSegment>()
  let firstPdt: number | undefined
  let timelineEnd: number | undefined
  let pendingSec: number | undefined
  let pendingPdt: number | undefined
  let mediaBefore = 0
  for (const raw of playlist.split('\n')) {
    const line = raw.trim()
    const dated = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/.exec(line)
    if (dated != null) {
      const ms = Date.parse(dated[1])
      if (Number.isFinite(ms)) {
        firstPdt ??= ms
        pendingPdt = ms
      }
    }
    const duration = /^#EXTINF:([\d.]+)/.exec(line)
    if (duration != null) pendingSec = Number.parseFloat(duration[1])
    const segment = /^(seg\d+\.m4s)$/.exec(line)
    if (segment == null) continue
    const mark = pendingPdt ?? timelineEnd
    const start =
      mark != null && firstPdt != null ? (mark - firstPdt) / 1000 : mediaBefore
    const seconds = pendingSec ?? 0
    listed.set(segment[1], { start, duration: seconds })
    if (pendingSec != null) {
      if (mark != null) timelineEnd = mark + pendingSec * 1000
      mediaBefore += pendingSec
    }
    pendingSec = undefined
    pendingPdt = undefined
  }
  return listed
}

/**
 * How much of a segment the restart reads to learn its start.
 *
 * `sidx` is the first media box. The pictures are the rest of the file, and a
 * late-game reconnect must not read those: one stream is several gigabytes,
 * and this runs on the ingest's thread.
 */
export const LEADING_BOX_BYTES = 64 * 1024

/** The opening boxes of a segment, and no more than {@link LEADING_BOX_BYTES}. */
export async function readLeadingBoxes(path: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(LEADING_BOX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, LEADING_BOX_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Where the timeline already listed ends: the last listed segment's own
 * stamped start plus its listed length. Undefined when the playlist lists
 * nothing or that segment cannot be read.
 */
export async function listedTimelineEndSec(
  directory: string,
  playlist: string | undefined
): Promise<number | undefined> {
  if (playlist == null) return undefined
  let last: { name: string; duration: number } | undefined
  let duration: number | undefined
  for (const raw of playlist.split('\n')) {
    const line = raw.trim()
    const listed = /^#EXTINF:([\d.]+)/.exec(line)
    if (listed != null) duration = Number.parseFloat(listed[1])
    if (/^seg\d+\.m4s$/.test(line) && duration != null) {
      last = { name: line, duration }
      duration = undefined
    }
  }
  if (last == null) return undefined
  try {
    const start = timelineStartSec(
      readFileSync(`${directory}/init.mp4`),
      await readLeadingBoxes(`${directory}/${last.name}`)
    )
    return start == null ? undefined : start + last.duration
  } catch {
    return undefined
  }
}

const yieldTurn = async (): Promise<void> => {
  await new Promise<void>(resolve => {
    setImmediate(resolve)
  })
}

/**
 * Beside the playlist: the number below which every segment is on the
 * programme clock, as the writers so far recorded it. A dot file, so it is
 * neither served nor sent to the Space with the recording.
 */
const PLACED_BELOW_FILE = '.placed-below'

/**
 * Records beside the playlist that every segment numbered below `below` is
 * on the programme clock: a continuing writer's once it has stamped them, and
 * every one a first writer closes (`Infinity`), which needs no stamp. It
 * outlives this process, so a restart's recovery does not judge them again.
 * A segment its frame wall clocks placed sits off its program date by the
 * difference between two writers' capture-to-start lags, which can pass for
 * one left unstamped. A failed write leaves the recovery reading more.
 */
export function recordPlacedBelow(directory: string, below: number): void {
  try {
    writeStamped(
      `${directory}/${PLACED_BELOW_FILE}`,
      Buffer.from(String(below))
    )
  } catch {
    // The directory is gone, or the disk full.
  }
}

/** What {@link recordPlacedBelow} last recorded; nought when nothing is. */
export function placedBelowOnDisk(directory: string): number {
  try {
    const below = Number(
      readFileSync(`${directory}/${PLACED_BELOW_FILE}`, 'utf8').trim()
    )
    return below >= 0 ? below : 0
  } catch {
    return 0
  }
}

/**
 * Moves segments a restarted writer would otherwise leave on the publisher's
 * clock.
 *
 * FFmpeg closes a segment with its timestamps still measured from that
 * publisher's zero, and the stamp runs after the file is already in the
 * directory. On the next start, a segment whose date is past the media
 * already listed, and whose own timeline is not, is moved onto that date.
 * That is a file still inside the publisher's opening offset, or one a
 * second or more behind its date. The first part of the broadcast is at
 * that zero because that is where it belongs. Each segment is judged from
 * its opening boxes, and the turn is handed back between them, so the rest
 * of the ingest keeps running. A segment still before the last discontinuity
 * is included: a later writer may already have marked its own join, and
 * leaving that file at zero would be permanent. Segments numbered below
 * `from`, or below the number recorded beside the playlist
 * ({@link recordPlacedBelow}), are known to be on the programme clock
 * already, as the writers before placed them, and are neither read nor
 * judged: late in a long game that is a thousand files or more ahead of
 * every reconnect, and one its frame wall clocks placed is where it belongs
 * whatever its date says. Returns the names moved.
 */
export async function recoverUnstampedSegments(
  directory: string,
  playlist: string | undefined,
  offsetSec: number,
  from = 0
): Promise<string[]> {
  if (!(offsetSec > 0) || playlist == null) return []
  const listed = listedProgramme(playlist)
  let init: Buffer
  try {
    init = readFileSync(`${directory}/init.mp4`)
  } catch {
    return []
  }
  const below = Math.max(from, placedBelowOnDisk(directory))
  const moved: string[] = []
  let placedEnd = 0
  for (const name of [...listed.keys()].sort()) {
    const programme = listed.get(name)
    if (programme == null) continue
    if ((segmentNumber(name) ?? 0) < below) {
      placedEnd = Math.max(placedEnd, programme.start + programme.duration)
      continue
    }
    await yieldTurn()
    let actual: number | undefined
    try {
      actual = timelineStartSec(
        init,
        await readLeadingBoxes(`${directory}/${name}`)
      )
    } catch {
      continue
    }
    if (actual == null) continue
    const behind = programme.start - actual
    const pastListed =
      programme.start > placedEnd + FRAME_SLACK_SEC &&
      offsetSec > placedEnd + FRAME_SLACK_SEC
    const unstamped =
      behind > CLEARLY_BEHIND_SEC ||
      (actual <= PUBLISHER_ZERO_SEC && pastListed && behind > FRAME_SLACK_SEC)
    if (!unstamped) {
      placedEnd = Math.max(placedEnd, programme.start + programme.duration)
      continue
    }
    if (stampFile(directory, name, init, behind)) moved.push(name)
    placedEnd = Math.max(placedEnd, programme.start + programme.duration)
  }
  return moved
}

function stampFile(
  directory: string,
  name: string,
  init: Buffer,
  offsetSec: number
): boolean {
  if (!(offsetSec > 0)) return false
  try {
    const path = `${directory}/${name}`
    const next = placeSegmentOnTimeline(init, readFileSync(path), offsetSec)
    if (next == null) return false
    writeStamped(path, next)
    return true
  } catch {
    return false
  }
}

/** A segment's file name, as the HLS writer names it (`seg%06d.m4s`). */
export function segmentName(segment: number): string {
  return `seg${String(segment).padStart(6, '0')}.m4s`
}

/** The number in a segment's file name; undefined for any other file. */
export function segmentNumber(name: string): number | undefined {
  const match = /^seg(\d+)\.m4s$/.exec(name)
  return match == null ? undefined : Number.parseInt(match[1], 10)
}

/**
 * The segments in the directory numbered `from` on, up to the first number
 * with no file. The writer closes its segments in order, each under its
 * final name only once it is whole (`temp_file`), so these are every one it
 * has closed since `from`. One look per name, rather than a listing of the
 * whole directory, which late in a game holds a thousand names or more.
 */
export function segmentsFrom(directory: string, from: number): string[] {
  const names: string[] = []
  for (
    let segment = from;
    existsSync(`${directory}/${segmentName(segment)}`);
    segment += 1
  ) {
    names.push(segmentName(segment))
  }
  return names
}

/**
 * Moves each of these segments, ones ffmpeg has closed since the restart,
 * onto the programme clock. Returns the names it moved; one it cannot move
 * yet is left as it was.
 */
export function stampNewSegments(
  directory: string,
  offsetSec: number,
  names: readonly string[]
): string[] {
  if (!(offsetSec > 0)) return []
  const moved: string[] = []
  let init: Buffer | undefined
  for (const name of names) {
    try {
      init ??= readFileSync(`${directory}/init.mp4`)
    } catch {
      return moved
    }
    if (stampFile(directory, name, init, offsetSec)) moved.push(name)
  }
  return moved
}

/**
 * Moves segments this writer already stamped at `fromSec` to `toSec`: a
 * returning publish whose publisher said where its first picture belongs
 * after its first segments were closed. Only the names given are touched, so
 * the init segment and everything listed before the return stay exactly as
 * they were. Returns the names it moved.
 */
export function restampSegments(
  directory: string,
  names: Iterable<string>,
  fromSec: number,
  toSec: number
): string[] {
  if (!(toSec > 0) || fromSec === toSec) return []
  let init: Buffer
  try {
    init = readFileSync(`${directory}/init.mp4`)
  } catch {
    return []
  }
  const moved: string[] = []
  for (const name of names) {
    if (!/^seg\d+\.m4s$/.test(name)) continue
    try {
      const path = `${directory}/${name}`
      const next = moveSegmentOnTimeline(
        init,
        readFileSync(path),
        fromSec,
        toSec
      )
      if (next == null) continue
      writeStamped(path, next)
      moved.push(name)
    } catch {
      // Gone, or not movable: left where it was.
    }
  }
  return moved
}
