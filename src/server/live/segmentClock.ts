import { readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { open } from 'fs/promises'

import { readTracks } from '../media/trackStarts'

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
  if (version === 1) {
    buffer.writeBigUInt64BE(buffer.readBigUInt64BE(at) + ticks, at)
    return
  }
  const sum = BigInt(buffer.readUInt32BE(at)) + ticks
  if (sum > 0xffffffffn) {
    throw new Error('timeline offset does not fit this box')
  }
  buffer.writeUInt32BE(Number(sum), at)
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
          BigInt(Math.round(offsetSec * timescale))
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
      const ticks = BigInt(Math.round(offsetSec * timescale))
      for (const stamp of stamps) {
        addTicks(out, stamp.payload + 4, out[stamp.payload], ticks)
      }
    }
  }
  return out
}

/**
 * Where a segment sits on the playlist's timeline, from its `sidx` and the
 * init segment's timescale. Undefined when either box is missing.
 */
export function timelineStartSec(
  init: Buffer,
  segment: Buffer
): number | undefined {
  const timescale = movieTimescale(init)
  const earliest = earliestPresentation(segment)
  if (timescale == null || earliest == null || timescale <= 0) return undefined
  return Number(earliest) / timescale
}

function movieTimescale(init: Buffer): number | undefined {
  const at = init.indexOf('mdhd')
  if (at < 0) return undefined
  const version = init[at + 4]
  const offset = version === 1 ? at + 24 : at + 16
  if (offset + 4 > init.length) return undefined
  return init.readUInt32BE(offset)
}

function earliestPresentation(segment: Buffer): bigint | undefined {
  const at = segment.indexOf('sidx')
  if (at < 0) return undefined
  const version = segment[at + 4]
  if (version === 1) {
    if (at + 24 > segment.length) return undefined
    return segment.readBigUInt64BE(at + 16)
  }
  if (at + 20 > segment.length) return undefined
  return BigInt(segment.readUInt32BE(at + 16))
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

const yieldTurn = async (): Promise<void> => {
  await new Promise<void>(resolve => {
    setImmediate(resolve)
  })
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
 * leaving that file at zero would be permanent. Returns the names moved.
 */
export async function recoverUnstampedSegments(
  directory: string,
  playlist: string | undefined,
  offsetSec: number
): Promise<string[]> {
  if (!(offsetSec > 0) || playlist == null) return []
  const listed = listedProgramme(playlist)
  let names: string[]
  try {
    names = readdirSync(directory)
      .filter(name => /^seg\d+\.m4s$/.test(name))
      .sort()
  } catch {
    return []
  }
  let init: Buffer
  try {
    init = readFileSync(`${directory}/init.mp4`)
  } catch {
    return []
  }
  const moved: string[] = []
  let placedEnd = 0
  for (const name of names) {
    await yieldTurn()
    const programme = listed.get(name)
    if (programme == null) continue
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

/**
 * Moves each segment ffmpeg has closed since the restart onto the programme
 * clock. Segments in `skip` — the ones already on the programme clock, and
 * the ones already moved — are left as they were written. Returns the names
 * it moved.
 */
export function stampNewSegments(
  directory: string,
  offsetSec: number,
  skip: ReadonlySet<string>
): string[] {
  if (!(offsetSec > 0)) return []
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const moved: string[] = []
  let init: Buffer | undefined
  for (const name of names) {
    if (!/^seg\d+\.m4s$/.test(name) || skip.has(name)) continue
    try {
      init ??= readFileSync(`${directory}/init.mp4`)
    } catch {
      return moved
    }
    if (stampFile(directory, name, init, offsetSec)) moved.push(name)
  }
  return moved
}
