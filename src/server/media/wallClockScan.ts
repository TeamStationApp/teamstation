import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  decodeWallClockSei,
  isPlausibleWallMs,
  isSliceNal,
  nalType,
  SEI_NAL_TYPE,
  type SeiCodec,
  type WallClockStamp
} from '../../common/wallClockSei'
import { MEDIA_PLAYLIST } from './ffmpeg'

/**
 * Reading the wall clock out of a fragmented MP4: the frames' own SEI
 * (`src/common/wallClockSei.ts`), placed on the video's playlist time.
 *
 * Every recording TeamStation keeps is fMP4 HLS, live or finished, so this is
 * the one reader: a live segment as the controller finds it, a recording a
 * stream has just become, and an upload's remux. It reads the boxes it needs
 * (`moov` for the track, then each `moof`'s `tfdt` and `trun` and the samples
 * they point at in the `mdat`) and only the head of each sample, to the first
 * slice, which is where a frame's SEI is.
 *
 * What it keeps is a handful of points, not a frame each: a programme is
 * thirty stamps a second for hours, and between points the video runs at 1×.
 */

/** One box: its four-character type and where it is in the buffer. */
export interface Box {
  type: string
  start: number
  /** Where its contents begin, after the size and type (and a large size). */
  body: number
  end: number
}

/** The boxes laid end to end between `start` and `end`. */
export function readBoxes(
  buffer: Uint8Array,
  start: number,
  end: number
): Box[] {
  const view = viewOf(buffer)
  const boxes: Box[] = []
  let at = start
  while (at + 8 <= end) {
    let size = view.getUint32(at)
    const type = fourCc(buffer, at + 4)
    let body = at + 8
    if (size === 1) {
      if (at + 16 > end) break
      size = Number(view.getBigUint64(at + 8))
      body = at + 16
    } else if (size === 0) {
      size = end - at
    }
    // A box that says it is shorter than its own header, or runs past what
    // was read, ends the walk: what follows it cannot be found.
    if (size < body - at || at + size > end) break
    boxes.push({ type, start: at, body, end: at + size })
    at += size
  }
  return boxes
}

/** The first child of `box` of each type in `path`, in turn. */
export function findBox(
  buffer: Uint8Array,
  box: Box,
  path: string[],
  /** Bytes between the box's header and its children (a sample entry's). */
  skip = 0
): Box | undefined {
  let current: Box | undefined = box
  for (const [i, type] of path.entries()) {
    if (current == null) return undefined
    current = readBoxes(
      buffer,
      current.body + (i === 0 ? skip : 0),
      current.end
    ).find(child => child.type === type)
  }
  return current
}

/** The video track of an init segment, as the fragments refer to it. */
export interface VideoTrack {
  trackId: number
  /** Units per second of every time in the fragments. */
  timescale: number
  codec: SeiCodec
  /** Bytes in each NAL unit's length prefix. */
  lengthSize: number
  /** `trex`'s defaults, for a fragment that leaves a field out. */
  defaultDuration: number
  defaultSize: number
}

/**
 * The video track an init segment (or a whole fMP4 file, whose head is one)
 * describes, or null when it has no H.264 or HEVC track.
 */
export function videoTrackOf(buffer: Uint8Array): VideoTrack | null {
  const view = viewOf(buffer)
  const moov = readBoxes(buffer, 0, buffer.length).find(
    box => box.type === 'moov'
  )
  if (moov == null) return null
  for (const trak of readBoxes(buffer, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue
    const hdlr = findBox(buffer, trak, ['mdia', 'hdlr'])
    if (hdlr == null || fourCc(buffer, hdlr.body + 8) !== 'vide') continue
    const tkhd = findBox(buffer, trak, ['tkhd'])
    const mdhd = findBox(buffer, trak, ['mdia', 'mdhd'])
    const stsd = findBox(buffer, trak, ['mdia', 'minf', 'stbl', 'stsd'])
    if (tkhd == null || mdhd == null || stsd == null) continue
    const trackId = view.getUint32(
      tkhd.body + (buffer[tkhd.body] === 1 ? 20 : 12)
    )
    const timescale = view.getUint32(
      mdhd.body + (buffer[mdhd.body] === 1 ? 20 : 12)
    )
    // The sample entries follow stsd's version, flags and entry count.
    const entry = readBoxes(buffer, stsd.body + 8, stsd.end)[0]
    if (entry == null) continue
    // A visual sample entry holds 78 bytes of its own before its children.
    const hevc = ['hvc1', 'hev1'].includes(entry.type)
    const avc = ['avc1', 'avc3'].includes(entry.type)
    if (!hevc && !avc) continue
    const config = findBox(buffer, entry, [hevc ? 'hvcC' : 'avcC'], 78)
    if (config == null) continue
    const lengthSize = (buffer[config.body + (hevc ? 21 : 4)] & 3) + 1
    const mvex = findBox(buffer, moov, ['mvex'])
    const trex =
      mvex == null
        ? undefined
        : readBoxes(buffer, mvex.body, mvex.end).find(
            box =>
              box.type === 'trex' && view.getUint32(box.body + 4) === trackId
          )
    return {
      trackId,
      timescale,
      codec: hevc ? 'hevc' : 'h264',
      lengthSize,
      defaultDuration: trex == null ? 0 : view.getUint32(trex.body + 12),
      defaultSize: trex == null ? 0 : view.getUint32(trex.body + 16)
    }
  }
  return null
}

/** One sample of a fragment, located in the buffer. */
export interface Sample {
  /** Decode time, in the track's timescale. */
  dts: number
  /** Presentation time, in the track's timescale. */
  pts: number
  /** Where its bytes are in the buffer. */
  offset: number
  size: number
}

/** A track fragment's header, as far as the samples need it. */
export interface TrackFragmentHeader {
  flags: number
  trackId: number
  baseDataOffset?: number
  defaultDuration?: number
  defaultSize?: number
}

/**
 * A box whose fields run past its own end: a fragment cut short or damaged.
 * Said in so many words, rather than as whatever reading past the end of
 * the buffer would throw, so a caller can tell a bad segment from a failure
 * of its own.
 */
export class MalformedBox extends Error {
  constructor(box: Box) {
    super(`the ${box.type} box at byte ${box.start} runs past its end`)
    this.name = 'MalformedBox'
  }
}

/** The fields of one box, read only from inside it. */
function fieldsOf(
  buffer: Uint8Array,
  box: Box
): {
  u32: (at: number) => number
  i32: (at: number) => number
  u64: (at: number) => number
} {
  const view = viewOf(buffer)
  const inside = (at: number, bytes: number): number => {
    if (at < box.body || at + bytes > box.end) throw new MalformedBox(box)
    return at
  }
  return {
    u32: at => view.getUint32(inside(at, 4)),
    i32: at => view.getInt32(inside(at, 4)),
    u64: at => Number(view.getBigUint64(inside(at, 8)))
  }
}

export function readTfhd(buffer: Uint8Array, tfhd: Box): TrackFragmentHeader {
  const field = fieldsOf(buffer, tfhd)
  const flags = field.u32(tfhd.body) & 0xffffff
  const header: TrackFragmentHeader = {
    flags,
    trackId: field.u32(tfhd.body + 4)
  }
  let at = tfhd.body + 8
  if ((flags & 0x1) !== 0) {
    header.baseDataOffset = field.u64(at)
    at += 8
  }
  if ((flags & 0x2) !== 0) at += 4
  if ((flags & 0x8) !== 0) {
    header.defaultDuration = field.u32(at)
    at += 4
  }
  if ((flags & 0x10) !== 0) header.defaultSize = field.u32(at)
  return header
}

/** One `trun`: its fields as read, sample by sample. */
export interface TrackRun {
  version: number
  flags: number
  dataOffset: number
  firstSampleFlags?: number
  samples: Array<{
    duration?: number
    size?: number
    flags?: number
    compositionOffset?: number
  }>
}

/**
 * More samples than one run of a real fragment holds: a run that gives no
 * field per sample, whose count cannot be checked against its length, is
 * refused past this rather than believed.
 */
const MAX_SAMPLES_PER_RUN = 1 << 20

export function readTrun(buffer: Uint8Array, trun: Box): TrackRun {
  const field = fieldsOf(buffer, trun)
  const flags = field.u32(trun.body) & 0xffffff
  const version = buffer[trun.body]
  const count = field.u32(trun.body + 4)
  let at = trun.body + 8
  const run: TrackRun = { version, flags, dataOffset: 0, samples: [] }
  if ((flags & 0x1) !== 0) {
    run.dataOffset = field.i32(at)
    at += 4
  }
  if ((flags & 0x4) !== 0) {
    run.firstSampleFlags = field.u32(at)
    at += 4
  }
  // Every sample's fields have to fit in the box, checked before any is
  // read, so a count gone wrong is refused at once and not after millions.
  const perSample =
    4 * [0x100, 0x200, 0x400, 0x800].filter(bit => (flags & bit) !== 0).length
  if (count * perSample > trun.end - at || count > MAX_SAMPLES_PER_RUN)
    throw new MalformedBox(trun)
  for (let i = 0; i < count; i++) {
    const sample: TrackRun['samples'][number] = {}
    if ((flags & 0x100) !== 0) {
      sample.duration = field.u32(at)
      at += 4
    }
    if ((flags & 0x200) !== 0) {
      sample.size = field.u32(at)
      at += 4
    }
    if ((flags & 0x400) !== 0) {
      sample.flags = field.u32(at)
      at += 4
    }
    if ((flags & 0x800) !== 0) {
      sample.compositionOffset = version === 0 ? field.u32(at) : field.i32(at)
      at += 4
    }
    run.samples.push(sample)
  }
  return run
}

/**
 * The samples of one track in a `moof`, with where their bytes are.
 *
 * `fileOffset` is where `buffer` begins in the file it was read from, for a
 * fragment that gives its data's position as a file offset rather than from
 * its own `moof`.
 */
export function fragmentSamples(
  buffer: Uint8Array,
  moof: Box,
  track: VideoTrack,
  fileOffset = 0
): Sample[] {
  const samples: Sample[] = []
  for (const traf of readBoxes(buffer, moof.body, moof.end)) {
    if (traf.type !== 'traf') continue
    const children = readBoxes(buffer, traf.body, traf.end)
    const tfhdBox = children.find(box => box.type === 'tfhd')
    if (tfhdBox == null) continue
    const tfhd = readTfhd(buffer, tfhdBox)
    if (tfhd.trackId !== track.trackId) continue
    const tfdt = children.find(box => box.type === 'tfdt')
    let decodeTime =
      tfdt == null
        ? 0
        : buffer[tfdt.body] === 1
          ? fieldsOf(buffer, tfdt).u64(tfdt.body + 4)
          : fieldsOf(buffer, tfdt).u32(tfdt.body + 4)
    const base =
      tfhd.baseDataOffset == null
        ? moof.start
        : tfhd.baseDataOffset - fileOffset
    for (const box of children) {
      if (box.type !== 'trun') continue
      const run = readTrun(buffer, box)
      let offset = base + run.dataOffset
      for (const entry of run.samples) {
        const size = entry.size ?? tfhd.defaultSize ?? track.defaultSize
        samples.push({
          dts: decodeTime,
          pts: decodeTime + (entry.compositionOffset ?? 0),
          offset,
          size
        })
        offset += size
        decodeTime +=
          entry.duration ?? tfhd.defaultDuration ?? track.defaultDuration
      }
    }
  }
  return samples
}

/**
 * The stamp in a sample's SEI, or null when it has none of ours.
 *
 * Only the NAL units before the first slice are read: an SEI that belongs to
 * a frame comes before its picture.
 */
export function stampOfSample(
  buffer: Uint8Array,
  sample: Sample,
  track: VideoTrack
): WallClockStamp | null {
  for (const nal of nalUnits(buffer, sample, track.lengthSize)) {
    const type = nalType(track.codec, nal)
    if (type === SEI_NAL_TYPE[track.codec]) {
      const stamp = decodeWallClockSei(track.codec, nal)
      if (stamp != null) return stamp
    } else if (isSliceNal(track.codec, nal)) {
      return null
    }
  }
  return null
}

/** A sample's NAL units, each without its length prefix. */
export function* nalUnits(
  buffer: Uint8Array,
  sample: Sample,
  lengthSize: number
): Generator<Uint8Array> {
  const end = Math.min(sample.offset + sample.size, buffer.length)
  let at = sample.offset
  while (at + lengthSize <= end) {
    let length = 0
    for (let i = 0; i < lengthSize; i++) length = length * 256 + buffer[at + i]
    at += lengthSize
    if (length === 0 || at + length > end) return
    yield buffer.subarray(at, at + length)
    at += length
  }
}

/** A frame placed on the playlist, with what it says about itself. */
export interface ScannedFrame {
  mediaMs: number
  stamp: WallClockStamp | null
}

/**
 * Where a run of segments sits on the playlist: a frame presenting at
 * `decodeMs` on the stream's own clock is at `mediaMs` on the playlist's.
 */
export interface Placement {
  decodeMs: number
  mediaMs: number
}

/** One segment as the playlist lists it, for placing its frames. */
export interface SegmentPlace {
  /** The `EXTINF` of every segment before it, in ms. */
  startMs: number
  /** Its own `EXTINF`, in ms. */
  durationMs: number
  /** A discontinuity comes before it: the stream's clock started again. */
  discontinuity: boolean
  /** Where `buffer` begins in the file it was read from. */
  fileOffset?: number
}

/**
 * The video frames of one segment (an fMP4 fragment or several), in
 * presentation order, on the playlist's time, the time a player reports.
 *
 * That time is placed the way hls.js places it. The first segment of a run
 * puts its first decode time (its `tfdt`) at its own place on the playlist,
 * the `EXTINF` of every segment before it, and the run's later segments carry
 * on from there on their own timestamps. A discontinuity starts a new run, as
 * does a segment whose timestamps have strayed from its place on the playlist
 * by its own length (a second at least), which is where the player starts a
 * new one too. So a publisher that reconnects, and starts its timestamps again
 * behind a discontinuity, continues the one timeline; and a segment whose
 * `EXTINF` is a frame or two off its timestamps (B-frames, an open GOP) moves
 * nothing.
 *
 * `previous` is the placement the segment before ended with, and the answer
 * carries the placement on.
 */
export function scanSegment(
  buffer: Uint8Array,
  track: VideoTrack,
  place: SegmentPlace,
  previous?: Placement
): { frames: ScannedFrame[]; placement?: Placement } {
  const samples = readBoxes(buffer, 0, buffer.length)
    .filter(box => box.type === 'moof')
    .flatMap(moof => fragmentSamples(buffer, moof, track, place.fileOffset))
    .sort((a, b) => a.pts - b.pts)
  if (samples.length === 0) return { frames: [], placement: previous }
  const toMs = (time: number): number => (time * 1000) / track.timescale
  const decodeMs = toMs(Math.min(...samples.map(sample => sample.dts)))
  const strayed =
    previous != null &&
    Math.abs(previous.mediaMs + decodeMs - previous.decodeMs - place.startMs) >=
      Math.max(place.durationMs, 1000)
  const placement =
    previous == null || place.discontinuity || strayed
      ? { decodeMs, mediaMs: place.startMs }
      : previous
  return {
    frames: samples.map(sample => ({
      mediaMs: Math.round(
        placement.mediaMs + toMs(sample.pts) - placement.decodeMs
      ),
      stamp: stampOfSample(buffer, sample, track)
    })),
    placement
  }
}

/** A point of the wall timeline, ready for `video_wall_anchors`. */
export interface WallPoint {
  mediaMs: number
  wallMs: number
  corrected: boolean
}

/** How far apart the kept points are while nothing moves. */
export const KEEP_EVERY_MS = 500
/** How far a frame may stray from 1× before it is a point of its own. */
export const DEPARTURE_MS = 20

/**
 * The points worth keeping out of a run of stamped frames: the first, one
 * every half second, and any frame whose wall clock is more than 20 ms from
 * where the last point at 1× puts it, which is a jump (an outage, a clock
 * correction) and where the timeline must turn.
 *
 * `last` is the point kept before these frames, for a scan that carries on
 * from an earlier one; the points answered are only the new ones.
 */
export function thinStamps(
  frames: ScannedFrame[],
  last?: WallPoint
): WallPoint[] {
  const kept: WallPoint[] = []
  let previous = last
  for (const frame of frames) {
    // Only a wall clock the timeline can hold: the decoder refuses anything
    // else, and this is where every point to be stored comes through.
    if (frame.stamp == null || !isPlausibleWallMs(frame.stamp.wallMs)) continue
    const point = {
      mediaMs: frame.mediaMs,
      wallMs: frame.stamp.wallMs,
      corrected: frame.stamp.corrected
    }
    if (previous != null && point.mediaMs <= previous.mediaMs) continue
    const keep =
      previous == null ||
      point.mediaMs - previous.mediaMs >= KEEP_EVERY_MS ||
      Math.abs(
        point.wallMs - (previous.wallMs + point.mediaMs - previous.mediaMs)
      ) > DEPARTURE_MS
    if (!keep) continue
    kept.push(point)
    previous = point
  }
  return kept
}

/** One segment of a media playlist. */
export interface PlaylistSegment {
  uri: string
  durationSec: number
  /** A byte range of `uri`, for a single-file recording. */
  range?: { offset: number; length: number }
  /** `EXT-X-DISCONTINUITY` before it: the publisher went and came back. */
  discontinuity: boolean
  /** The `EXT-X-MAP` in force, when it is not the playlist's first. */
  map?: PlaylistMap
}

/** An init segment, whole or as a byte range of a recording's one file. */
export interface PlaylistMap {
  uri: string
  range?: { offset: number; length: number }
}

export interface MediaPlaylist {
  /** The first `EXT-X-MAP`: where the first segment's init segment is. */
  map?: PlaylistMap
  segments: PlaylistSegment[]
  ended: boolean
}

/** Reads an HLS media playlist, as FFmpeg writes them. */
export function parseMediaPlaylist(text: string): MediaPlaylist {
  const playlist: MediaPlaylist = { segments: [], ended: false }
  let duration: number | undefined
  let range: PlaylistSegment['range']
  let discontinuity = false
  let rangeEnd = 0
  let later: PlaylistMap | undefined
  // A byte range without an offset starts where the last one ended.
  const readRange = (value: string): { offset: number; length: number } => {
    const [length, offset] = value.split('@').map(Number)
    const at = offset ?? rangeEnd
    rangeEnd = at + length
    return { offset: at, length }
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = /URI="([^"]*)"/.exec(line)?.[1] ?? ''
      const byterange = /BYTERANGE="([^"]*)"/.exec(line)?.[1]
      const map: PlaylistMap = {
        uri,
        ...(byterange == null ? {} : { range: readRange(byterange) })
      }
      if (playlist.map == null) playlist.map = map
      else later = map
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice('#EXTINF:'.length))
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      range = readRange(line.slice('#EXT-X-BYTERANGE:'.length))
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true
    } else if (line === '#EXT-X-ENDLIST') {
      playlist.ended = true
    } else if (line !== '' && !line.startsWith('#') && duration != null) {
      playlist.segments.push({
        uri: line,
        durationSec: duration,
        ...(range == null ? {} : { range }),
        ...(later == null ? {} : { map: later }),
        discontinuity
      })
      duration = undefined
      range = undefined
      discontinuity = false
    }
  }
  return playlist
}

/** Reads a whole file, or the byte range of it a playlist names. */
export async function readPart(
  path: string,
  range?: { offset: number; length: number }
): Promise<Uint8Array> {
  if (range == null) return await readFile(path)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(range.length)
    const { bytesRead } = await handle.read(
      buffer,
      0,
      range.length,
      range.offset
    )
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * A stretch of a recording whose frames all carry a stamp the timeline can
 * hold: from the first of them up to the first frame after them that does
 * not, or the recording's end, in ms on its playlist.
 */
export type StampedSpan = [startMs: number, endMs: number]

/** A whole recording read for its wall clock. */
export interface RecordingScan {
  points: WallPoint[]
  /** Where its frames are stamped, in order: nowhere else. */
  stamped: StampedSpan[]
  /** Its length on the playlist, the sum of every `EXTINF`. */
  durationMs: number
}

/**
 * The wall-clock points of a recording: a directory holding the byte-range
 * playlist (`video.m3u8`) and the one fMP4 file it points into, as every
 * remux writes them. Empty for a recording none of whose frames are stamped.
 */
export async function scanRecording(
  dir: string,
  options: { onlyIfFirstStamped?: boolean; playlistFile?: string } = {}
): Promise<WallPoint[]> {
  return (await readRecordingStamps(dir, options)).points
}

/**
 * A recording's wall-clock points, and where its frames are stamped: a
 * stream that changed publisher part way is stamped only in places.
 *
 * Read a segment at a time, so a three-hour game is never in memory at once.
 *
 * `onlyIfFirstStamped` gives up after the first segment when none of its
 * frames is stamped. An upload is stamped from its first frame or not at
 * all: only TS Director's live programme carries the stamp, and a take from
 * a camera never does. So its first segment says which, and a take of
 * several gigabytes without any is not read through a second time for
 * nothing. A live stream's recording is read whole, as a publisher that
 * reconnects may start carrying the stamp only then.
 */
export async function readRecordingStamps(
  dir: string,
  options: { onlyIfFirstStamped?: boolean; playlistFile?: string } = {}
): Promise<RecordingScan> {
  const none: RecordingScan = { points: [], stamped: [], durationMs: 0 }
  const playlist = parseMediaPlaylist(
    await readFile(join(dir, options.playlistFile ?? MEDIA_PLAYLIST), 'utf8')
  )
  if (playlist.map == null) return none
  const tracks = new Map<string, VideoTrack | null>()
  const trackOf = async (map: PlaylistMap): Promise<VideoTrack | null> => {
    const key = `${map.uri}@${String(map.range?.offset ?? 0)}`
    const held = tracks.get(key)
    if (held !== undefined) return held
    const track = videoTrackOf(await readPart(join(dir, map.uri), map.range))
    tracks.set(key, track)
    return track
  }
  const first = await trackOf(playlist.map)
  if (first == null) return none
  const points: WallPoint[] = []
  const stamped: StampedSpan[] = []
  /** Where the stamped stretch being read began, while it goes on. */
  let since: number | undefined
  let startMs = 0
  let placement: Placement | undefined
  for (const [index, segment] of playlist.segments.entries()) {
    const track = await trackOf(segment.map ?? playlist.map)
    if (track == null) {
      startMs += segment.durationSec * 1000
      continue
    }
    const bytes = await readPart(join(dir, segment.uri), segment.range)
    const scanned = scanSegment(
      bytes,
      track,
      {
        startMs,
        durationMs: segment.durationSec * 1000,
        discontinuity: segment.discontinuity,
        fileOffset: segment.range?.offset ?? 0
      },
      placement
    )
    if (
      index === 0 &&
      options.onlyIfFirstStamped === true &&
      !scanned.frames.some(frame => frame.stamp != null)
    )
      return none
    placement = scanned.placement
    points.push(...thinStamps(scanned.frames, points.at(-1)))
    for (const frame of scanned.frames) {
      const holds = frame.stamp != null && isPlausibleWallMs(frame.stamp.wallMs)
      if (holds && since == null) since = frame.mediaMs
      else if (!holds && since != null) {
        stamped.push([since, frame.mediaMs])
        since = undefined
      }
    }
    startMs += segment.durationSec * 1000
  }
  if (since != null) stamped.push([since, Math.max(startMs, since + 1)])
  return { points, stamped, durationMs: startMs }
}

/** Whether a frame at `mediaMs` is in one of the stamped `spans`. */
export function isStampedAt(spans: StampedSpan[], mediaMs: number): boolean {
  let low = 0
  let high = spans.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (spans[middle][1] <= mediaMs) low = middle + 1
    else high = middle
  }
  return low < spans.length && spans[low][0] <= mediaMs
}

function viewOf(buffer: Uint8Array): DataView {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

function fourCc(buffer: Uint8Array, at: number): string {
  return String.fromCharCode(...buffer.subarray(at, at + 4))
}
