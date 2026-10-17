import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { execFile } from 'child_process'
import { promisify } from 'util'

import { ffprobeFor } from '../media/ffmpeg'

const run = promisify(execFile)

/**
 * Black pictures and silence for a live recording's holes.
 *
 * A publisher that drops and comes back leaves a hole on the wall clock, and
 * the finished recording keeps it so the return plays at its own time. A hole
 * in a video track is a picture held for as long as the hole lasts, one sample
 * many seconds long, which is what broke recordings and live streams before:
 * like OBS, TeamStation instead fills it at the stream's own frame rate. Each
 * filler picture lasts one frame and is black, and the sound, when there is
 * any, is silence at the stream's own rate and layout, so picture and sound
 * stay the same length and the return opens at its wall time.
 *
 * The pictures are the stream's own codec, size and pixel format, encoded
 * here, so they need parameter sets of their own. The recording is one
 * fragmented MP4 with one sample entry, which every later `-c copy` keeps, so
 * the filler's VPS, SPS and PPS are renumbered to ids the phone does not use
 * and added beside the phone's in that one `hvcC`. Each slice names its own
 * PPS, so a decoder switches at the filler's first picture and back at the
 * return's keyframe, and the phone's pictures are copied untouched. Separate
 * init segments behind a discontinuity would need a playlist the single-file
 * recording does not have, and pictures relying on parameter sets in the
 * stream are not allowed in an `hvc1` track, which is what Safari plays.
 *
 * Every filler picture is a keyframe, and all of them are the same few hundred
 * bytes, so only one is encoded however long the hole is, and a seek into the
 * hole lands at once.
 */

/**
 * The longest hole that is filled, in seconds, as a guard against timestamps
 * that make no sense. A real hole is about the reconnect grace at most
 * (`RECONNECT_GRACE_MS`, eight minutes), plus however long the server took to
 * notice the publisher had gone, so this is far above it. A longer hole is
 * not filled short: the whole stream is left unfilled, as a stream whose
 * holes cannot be filled is, and the reason is logged.
 */
export const MAX_HOLE_SEC = 60 * 60

/** What a filler has to match. */
export interface StreamShape {
  width: number
  height: number
  pixFmt: string
  colorRange?: string
  colorSpace?: string
  colorTransfer?: string
  colorPrimaries?: string
  /** Stream order, which the concat demuxer matches by. */
  videoIndex: number
  /**
   * The picture track's timescale. The concat demuxer does not rescale a
   * later file's timestamps, so the filler's tracks keep the stream's.
   */
  videoTimescale: number
  sound?: { index: number; sampleRate: number; channelLayout: string }
}

/** The packets of one live segment, relative to its own start. */
export interface SegmentSpan {
  /** Seconds from the segment's start to the end of its last picture. */
  videoEnd: number
  /** Seconds from the segment's start to its first picture. */
  videoLead: number
  soundEnd?: number
  soundLead?: number
  /** The average length of a picture, in seconds. */
  frameSec: number
}

interface ProbedStream {
  index: number
  codec_type?: string
  codec_name?: string
  profile?: string
  width?: number
  height?: number
  pix_fmt?: string
  color_range?: string
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  sample_rate?: string
  channel_layout?: string
  channels?: number
  time_base?: string
}

/** The timescale of a `1/n` time base, or undefined for any other. */
function timescaleOf(timeBase?: string): number | undefined {
  const match = /^1\/(\d+)$/.exec(timeBase ?? '')
  return match == null ? undefined : Number(match[1])
}

/**
 * The stream's shape, read from one init-and-segment pair, or why a filler
 * cannot be made for it.
 */
export async function probeShape(
  ffmpegPath: string,
  pair: string
): Promise<StreamShape | string> {
  const { stdout } = await run(
    ffprobeFor(ffmpegPath),
    ['-v', 'error', '-show_streams', '-of', 'json', pair],
    { maxBuffer: 1 << 22 }
  )
  const streams = (JSON.parse(stdout) as { streams?: ProbedStream[] }).streams
  const video = streams?.find(stream => stream.codec_type === 'video')
  if (video == null) return 'no picture'
  if (video.codec_name !== 'hevc') return `pictures are ${video.codec_name}`
  const videoTimescale = timescaleOf(video.time_base)
  if (
    video.width == null ||
    video.height == null ||
    video.pix_fmt == null ||
    videoTimescale == null
  ) {
    return 'no picture size or timescale'
  }
  const audio = streams?.find(stream => stream.codec_type === 'audio')
  let sound: StreamShape['sound']
  if (audio != null) {
    if (audio.codec_name !== 'aac' || audio.profile !== 'LC') {
      return `sound is ${audio.codec_name} ${audio.profile}`
    }
    // An MP4 sound track's timescale is its sample rate.
    if (timescaleOf(audio.time_base) !== Number(audio.sample_rate)) {
      return `sound in a ${audio.time_base} time base`
    }
    sound = {
      index: audio.index,
      sampleRate: Number(audio.sample_rate),
      channelLayout:
        audio.channel_layout ?? (audio.channels === 1 ? 'mono' : 'stereo')
    }
  }
  const named = (value?: string): string | undefined =>
    value == null || value === 'unknown' ? undefined : value
  return {
    width: video.width,
    height: video.height,
    pixFmt: video.pix_fmt,
    colorRange: named(video.color_range),
    colorSpace: named(video.color_space),
    colorTransfer: named(video.color_transfer),
    colorPrimaries: named(video.color_primaries),
    videoIndex: video.index,
    videoTimescale,
    sound
  }
}

/** Where one segment's packets start and end, as the concat demuxer sees them. */
export async function probeSpan(
  ffmpegPath: string,
  pair: string,
  shape: StreamShape
): Promise<SegmentSpan> {
  const { stdout } = await run(
    ffprobeFor(ffmpegPath),
    [
      '-v',
      'error',
      '-show_entries',
      'format=start_time:packet=stream_index,pts_time,duration_time',
      '-of',
      'json',
      pair
    ],
    { maxBuffer: 1 << 26 }
  )
  const parsed = JSON.parse(stdout) as {
    format?: { start_time?: string }
    packets?: Array<{
      stream_index: number
      pts_time?: string
      duration_time?: string
    }>
  }
  const start = Number(parsed.format?.start_time ?? 0)
  const span = (
    index: number
  ): { lead: number; end: number; frame: number } | undefined => {
    const packets = (parsed.packets ?? []).filter(
      packet => packet.stream_index === index && packet.pts_time != null
    )
    if (packets.length === 0) return undefined
    const times = packets.map(packet => Number(packet.pts_time) - start)
    const durations = packets.map(packet => Number(packet.duration_time ?? 0))
    const lead = Math.min(...times)
    const last = Math.max(...times)
    return {
      lead,
      end: Math.max(...times.map((time, i) => time + durations[i])),
      // The average, since timestamps in milliseconds round each picture.
      frame:
        times.length > 1 ? (last - lead) / (times.length - 1) : durations[0]
    }
  }
  const video = span(shape.videoIndex)
  if (video == null) throw new Error(`no pictures in ${pair}`)
  const sound = shape.sound == null ? undefined : span(shape.sound.index)
  return {
    videoEnd: video.end,
    videoLead: video.lead,
    soundEnd: sound?.end,
    soundLead: sound?.lead,
    frameSec: video.frame > 0 ? video.frame : 1 / 30
  }
}

/** The usual frame rate nearest a measured frame length, as a fraction. */
export function frameRate(frameSec: number): { num: number; den: number } {
  const rates = [
    { num: 24000, den: 1001 },
    { num: 30000, den: 1001 },
    { num: 60000, den: 1001 },
    ...[15, 20, 24, 25, 30, 48, 50, 60, 90, 100, 120].map(num => ({
      num,
      den: 1
    }))
  ]
  // Timestamps in milliseconds put a 30 fps picture at 33 or 34 ms.
  const off = (rate: { num: number; den: number }): number =>
    Math.abs(rate.den / rate.num - frameSec)
  const near = rates.reduce((best, rate) =>
    off(rate) < off(best) ? rate : best
  )
  return off(near) <= 0.00101
    ? near
    : { num: Math.max(1, Math.round(1 / frameSec)), den: 1 }
}

/** One hole, as the concat list sees it. */
export interface HolePlan {
  /** Seconds the segment before the hole is given in the concat list. */
  beforeSec: number
  /** Seconds the filler is given; it ends where the return starts. */
  fillerSec: number
  frames: number
  /** Where the silence starts and how many AAC frames it lasts. */
  soundOffsetSec: number
  soundFrames: number
}

/**
 * How a hole between two segments is filled.
 *
 * The filler always ends exactly where the return's first picture starts, on
 * the return's frame grid, so the return keeps its wall time and every
 * picture in the hole lasts one frame however long the hole is; the part of a
 * frame left over goes to the picture before the hole. Silence starts where
 * the sound before the hole ends and stops short of the return's, never
 * overlapping either. Answers undefined for a gap under a frame, and why not
 * for a hole longer than `MAX_HOLE_SEC`, which only broken timestamps make.
 */
export function planHole(
  start: number,
  before: SegmentSpan,
  nextStart: number,
  next: SegmentSpan,
  rate: { num: number; den: number },
  sampleRate?: number
): HolePlan | string | undefined {
  const frame = rate.den / rate.num
  const pictureEnd = start + before.videoEnd
  const returnAt = nextStart + next.videoLead
  if (returnAt - pictureEnd > MAX_HOLE_SEC) {
    return `a ${(returnAt - pictureEnd).toFixed(1)} s hole is longer than ${MAX_HOLE_SEC} s`
  }
  const frames = Math.round((returnAt - pictureEnd) / frame)
  if (frames < 1) return undefined
  const fillerStart = returnAt - (frames * rate.den) / rate.num
  let soundOffsetSec = 0
  let soundFrames = 0
  if (sampleRate != null && before.soundEnd != null) {
    soundOffsetSec = Math.max(0, start + before.soundEnd - fillerStart)
    const soundStop = Math.min(
      nextStart + (next.soundLead ?? next.videoLead),
      fillerStart + frames * frame
    )
    soundFrames = Math.max(
      0,
      Math.floor(
        ((soundStop - fillerStart - soundOffsetSec) * sampleRate) / 1024
      )
    )
  }
  return {
    beforeSec: fillerStart - start,
    fillerSec: nextStart - fillerStart,
    frames,
    soundOffsetSec,
    soundFrames
  }
}

/* Parameter sets --------------------------------------------------------- */

const VPS = 32
const SPS = 33
const PPS = 34

function nalType(nal: Buffer): number {
  return (nal[0] >> 1) & 0x3f
}

/** The NAL units of an Annex B stream, without their start codes. */
export function annexBUnits(data: Buffer): Buffer[] {
  const starts: Array<{ at: number; code: number }> = []
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push({ at: i + 3, code: i > 0 && data[i - 1] === 0 ? 4 : 3 })
      i += 2
    }
  }
  return starts.map((start, index) =>
    data.subarray(
      start.at,
      index + 1 < starts.length
        ? starts[index + 1].at - starts[index + 1].code
        : data.length
    )
  )
}

function toRbsp(payload: Buffer): Buffer {
  const out: number[] = []
  for (let i = 0; i < payload.length; i++) {
    if (
      i >= 2 &&
      payload[i] === 3 &&
      payload[i - 1] === 0 &&
      payload[i - 2] === 0 &&
      out.length >= 2 &&
      out[out.length - 1] === 0 &&
      out[out.length - 2] === 0
    ) {
      continue
    }
    out.push(payload[i])
  }
  return Buffer.from(out)
}

function toPayload(rbsp: Buffer): Buffer {
  const out: number[] = []
  let zeros = 0
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3)
      zeros = 0
    }
    out.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  if (out[out.length - 1] === 0) out.push(3)
  return Buffer.from(out)
}

class Bits {
  pos = 0
  constructor(readonly data: Buffer) {}
  bit(): number {
    const byte = this.data[this.pos >> 3]
    if (byte == null) throw new Error('parameter set ends early')
    const value = (byte >> (7 - (this.pos & 7))) & 1
    this.pos++
    return value
  }

  u(n: number): number {
    let value = 0
    for (let i = 0; i < n; i++) value = value * 2 + this.bit()
    return value
  }

  ue(): number {
    let zeros = 0
    while (this.bit() === 0) {
      if (++zeros > 31) throw new Error('bad exp-Golomb code')
    }
    return 2 ** zeros - 1 + this.u(zeros)
  }

  se(): number {
    const value = this.ue()
    return value % 2 === 1 ? (value + 1) / 2 : -(value / 2)
  }

  skip(n: number): void {
    this.pos += n
  }

  /** Where the stop bit of the RBSP trailing bits is. */
  stopBit(): number {
    for (let at = this.data.length * 8 - 1; at >= 0; at--) {
      if (((this.data[at >> 3] >> (7 - (at & 7))) & 1) === 1) return at
    }
    throw new Error('no stop bit')
  }
}

class BitWriter {
  private readonly bits: number[] = []
  u(n: number, value: number): void {
    for (let i = n - 1; i >= 0; i--) {
      this.bits.push(Math.floor(value / 2 ** i) % 2)
    }
  }

  ue(value: number): void {
    const code = value + 1
    const length = Math.floor(Math.log2(code))
    this.u(length, 0)
    this.u(length + 1, code)
  }

  copy(from: Bits, start: number, end: number): void {
    const reader = new Bits(from.data)
    reader.pos = start
    while (reader.pos < end) this.bits.push(reader.bit())
  }

  /** A stop bit and zeros to the next byte. */
  align(): void {
    this.bits.push(1)
    while (this.bits.length % 8 !== 0) this.bits.push(0)
  }

  bytes(): Buffer {
    const out = Buffer.alloc(this.bits.length / 8)
    this.bits.forEach((bit, i) => {
      if (bit === 1) out[i >> 3] |= 0x80 >> (i & 7)
    })
    return out
  }
}

function skipProfileTierLevel(bits: Bits, maxSubLayersMinus1: number): void {
  bits.skip(96)
  const profile: number[] = []
  const level: number[] = []
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profile.push(bits.u(1))
    level.push(bits.u(1))
  }
  if (maxSubLayersMinus1 > 0) bits.skip(2 * (8 - maxSubLayersMinus1))
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    bits.skip(profile[i] * 88 + level[i] * 8)
  }
}

interface SpsFields {
  vpsId: number
  spsId: number
  /** Where the SPS id starts and ends, in RBSP bits. */
  idStart: number
  idEnd: number
}

function readSpsHead(bits: Bits): SpsFields {
  const vpsId = bits.u(4)
  const maxSubLayersMinus1 = bits.u(3)
  bits.skip(1)
  skipProfileTierLevel(bits, maxSubLayersMinus1)
  const idStart = bits.pos
  const spsId = bits.ue()
  return { vpsId, spsId, idStart, idEnd: bits.pos }
}

/** What an I slice header needs from its SPS. */
function readSpsForSlice(rbsp: Buffer): {
  separateColourPlane: boolean
  chroma: boolean
  sao: boolean
} {
  const again = new Bits(rbsp)
  again.skip(4)
  const subLayers = again.u(3)
  again.skip(1)
  skipProfileTierLevel(again, subLayers)
  again.ue()
  const chromaFormat = again.ue()
  const separateColourPlane = chromaFormat === 3 && again.u(1) === 1
  again.ue()
  again.ue()
  if (again.u(1) === 1) {
    for (let i = 0; i < 4; i++) again.ue()
  }
  again.ue()
  again.ue()
  again.ue()
  const ordering = again.u(1)
  for (let i = ordering === 1 ? 0 : subLayers; i <= subLayers; i++) {
    again.ue()
    again.ue()
    again.ue()
  }
  for (let i = 0; i < 6; i++) again.ue()
  if (again.u(1) === 1 && again.u(1) === 1) {
    throw new Error('the filler SPS carries scaling lists')
  }
  again.skip(1)
  return {
    separateColourPlane,
    chroma: chromaFormat !== 0 && !separateColourPlane,
    sao: again.u(1) === 1
  }
}

interface PpsFields {
  ppsId: number
  spsId: number
  outputFlagPresent: boolean
  extraSliceHeaderBits: number
  sliceChromaQpOffsets: boolean
  tilesOrWpp: boolean
  loopFilterAcrossSlices: boolean
  deblockingOverride: boolean
  deblockingDisabled: boolean
  headerExtension: boolean
}

function readPps(rbsp: Buffer): PpsFields {
  const bits = new Bits(rbsp)
  const ppsId = bits.ue()
  const spsId = bits.ue()
  bits.skip(1)
  const outputFlagPresent = bits.u(1) === 1
  const extraSliceHeaderBits = bits.u(3)
  bits.skip(2)
  bits.ue()
  bits.ue()
  bits.se()
  bits.skip(2)
  if (bits.u(1) === 1) bits.ue()
  bits.se()
  bits.se()
  const sliceChromaQpOffsets = bits.u(1) === 1
  bits.skip(3)
  const tiles = bits.u(1) === 1
  const wpp = bits.u(1) === 1
  if (tiles) throw new Error('the filler PPS has tiles')
  const loopFilterAcrossSlices = bits.u(1) === 1
  let deblockingOverride = false
  let deblockingDisabled = false
  if (bits.u(1) === 1) {
    deblockingOverride = bits.u(1) === 1
    deblockingDisabled = bits.u(1) === 1
    if (!deblockingDisabled) {
      bits.se()
      bits.se()
    }
  }
  if (bits.u(1) === 1) throw new Error('the filler PPS carries scaling lists')
  bits.skip(1)
  bits.ue()
  const headerExtension = bits.u(1) === 1
  if (bits.u(1) === 1) throw new Error('the filler PPS has extensions')
  return {
    ppsId,
    spsId,
    outputFlagPresent,
    extraSliceHeaderBits,
    sliceChromaQpOffsets,
    tilesOrWpp: wpp,
    loopFilterAcrossSlices,
    deblockingOverride,
    deblockingDisabled,
    headerExtension
  }
}

/** The ids a sample entry's parameter sets already use. */
function idsOf(nal: Buffer): number {
  const rbsp = toRbsp(nal.subarray(2))
  const type = nalType(nal)
  if (type === VPS) return rbsp[0] >> 4
  if (type === SPS) return readSpsHead(new Bits(rbsp)).spsId
  return new Bits(rbsp).ue()
}

function lowestFree(used: Set<number>): number {
  let id = 0
  while (used.has(id)) id++
  return id
}

/** One encoded black picture, renumbered to sit beside the phone's sets. */
export interface FillerPicture {
  /** The renumbered VPS, SPS and PPS. */
  parameterSets: Buffer[]
  /** The IDR slice, as a NAL unit without a start code. */
  slice: Buffer
}

/**
 * Renumbers an encoded black IDR picture's parameter sets so they do not
 * collide with the ones in `existing`, rewriting its slice to name the new
 * PPS. The slice header is re-aligned and the slice data copied as it is.
 */
export function renumberPicture(
  units: Buffer[],
  existing: Buffer[]
): FillerPicture {
  const vps = units.find(nal => nalType(nal) === VPS)
  const sps = units.find(nal => nalType(nal) === SPS)
  const pps = units.find(nal => nalType(nal) === PPS)
  const slices = units.filter(nal => nalType(nal) < 32)
  if (vps == null || sps == null || pps == null || slices.length !== 1) {
    throw new Error('the filler picture is not one IDR slice with its sets')
  }
  const used = (type: number): Set<number> =>
    new Set(existing.filter(nal => nalType(nal) === type).map(idsOf))
  const vpsId = lowestFree(used(VPS))
  const spsId = lowestFree(used(SPS))
  const ppsId = lowestFree(used(PPS))
  if (vpsId > 15 || spsId > 15 || ppsId > 63) {
    throw new Error('no parameter set ids are free')
  }

  const header = (nal: Buffer): Buffer => nal.subarray(0, 2)
  const finish = (nal: Buffer, rbsp: Buffer): Buffer =>
    Buffer.concat([header(nal), toPayload(rbsp)])

  const vpsRbsp = Buffer.from(toRbsp(vps.subarray(2)))
  vpsRbsp[0] = (vpsRbsp[0] & 0x0f) | (vpsId << 4)

  const spsRbsp = toRbsp(sps.subarray(2))
  const spsBits = new Bits(spsRbsp)
  const spsHead = readSpsHead(spsBits)
  const spsOut = new BitWriter()
  spsOut.u(4, vpsId)
  spsOut.copy(spsBits, 4, spsHead.idStart)
  spsOut.ue(spsId)
  spsOut.copy(spsBits, spsHead.idEnd, spsBits.stopBit())
  spsOut.align()

  const ppsRbsp = toRbsp(pps.subarray(2))
  const ppsFields = readPps(ppsRbsp)
  const ppsBits = new Bits(ppsRbsp)
  ppsBits.ue()
  ppsBits.ue()
  const ppsOut = new BitWriter()
  ppsOut.ue(ppsId)
  ppsOut.ue(spsId)
  ppsOut.copy(ppsBits, ppsBits.pos, ppsBits.stopBit())
  ppsOut.align()

  const slice = slices[0]
  const type = nalType(slice)
  if (type !== 19 && type !== 20) throw new Error('the filler is not an IDR')
  const spsFields = readSpsForSlice(spsRbsp)
  const sliceRbsp = toRbsp(slice.subarray(2))
  const bits = new Bits(sliceRbsp)
  if (bits.u(1) !== 1) throw new Error('the filler has several slices')
  bits.skip(1)
  const idStart = bits.pos
  bits.ue()
  const idEnd = bits.pos
  bits.skip(ppsFields.extraSliceHeaderBits)
  if (bits.ue() !== 2) throw new Error('the filler slice is not intra')
  if (ppsFields.outputFlagPresent) bits.skip(1)
  if (spsFields.separateColourPlane) bits.skip(2)
  let sao = false
  if (spsFields.sao) {
    sao = bits.u(1) === 1
    if (spsFields.chroma) sao = bits.u(1) === 1 || sao
  }
  bits.se()
  if (ppsFields.sliceChromaQpOffsets) {
    bits.se()
    bits.se()
  }
  let deblockingDisabled = ppsFields.deblockingDisabled
  if (ppsFields.deblockingOverride && bits.u(1) === 1) {
    deblockingDisabled = bits.u(1) === 1
    if (!deblockingDisabled) {
      bits.se()
      bits.se()
    }
  }
  if (ppsFields.loopFilterAcrossSlices && (sao || !deblockingDisabled)) {
    bits.skip(1)
  }
  if (ppsFields.tilesOrWpp) {
    const entries = bits.ue()
    if (entries > 0) bits.skip(entries * (bits.ue() + 1))
  }
  if (ppsFields.headerExtension) bits.skip(bits.ue() * 8)
  const headerEnd = bits.pos
  if (bits.u(1) !== 1) throw new Error('the filler slice header is misread')
  const dataStart = Math.ceil(bits.pos / 8)
  const sliceOut = new BitWriter()
  sliceOut.copy(bits, 0, idStart)
  sliceOut.ue(ppsId)
  sliceOut.copy(bits, idEnd, headerEnd)
  sliceOut.align()

  return {
    parameterSets: [
      finish(vps, vpsRbsp),
      finish(sps, spsOut.bytes()),
      finish(pps, ppsOut.bytes())
    ],
    slice: finish(
      slice,
      Buffer.concat([sliceOut.bytes(), sliceRbsp.subarray(dataStart)])
    )
  }
}

/* The sample entry -------------------------------------------------------- */

interface Box {
  type: string
  start: number
  end: number
  header: number
}

function boxesIn(data: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = []
  let at = start
  while (at + 8 <= end) {
    let size = data.readUInt32BE(at)
    let header = 8
    if (size === 1) {
      size = Number(data.readBigUInt64BE(at + 8))
      header = 16
    } else if (size === 0) {
      size = end - at
    }
    if (size < header || at + size > end) break
    boxes.push({
      type: data.toString('latin1', at + 4, at + 8),
      start: at,
      end: at + size,
      header
    })
    at += size
  }
  return boxes
}

/** The chain of boxes from `moov` down to the video track's `hvcC`. */
function hvcCPath(init: Buffer): Box[] | undefined {
  const moov = boxesIn(init, 0, init.length).find(box => box.type === 'moov')
  if (moov == null) return undefined
  for (const trak of boxesIn(init, moov.start + 8, moov.end)) {
    if (trak.type !== 'trak') continue
    const path = [moov, trak]
    let parent = trak
    for (const type of ['mdia', 'minf', 'stbl', 'stsd']) {
      const child = boxesIn(
        init,
        parent.start + parent.header,
        parent.end
      ).find(box => box.type === type)
      if (child == null) break
      path.push(child)
      parent = child
    }
    if (parent.type !== 'stsd') continue
    const entry = boxesIn(init, parent.start + 16, parent.end).find(
      box => box.type === 'hvc1' || box.type === 'hev1'
    )
    if (entry == null) continue
    // A visual sample entry's own fields come before its child boxes.
    const hvcC = boxesIn(init, entry.start + 8 + 78, entry.end).find(
      box => box.type === 'hvcC'
    )
    if (hvcC == null) continue
    return [...path, entry, hvcC]
  }
  return undefined
}

/** The parameter sets in an `hvcC`, and its NAL length size. */
export function hvcCUnits(hvcC: Buffer): {
  units: Buffer[]
  lengthSize: number
} {
  const lengthSize = (hvcC[21] & 3) + 1
  const units: Buffer[] = []
  let at = 23
  for (let array = 0; array < hvcC[22]; array++) {
    const count = hvcC.readUInt16BE(at + 1)
    at += 3
    for (let i = 0; i < count; i++) {
      const length = hvcC.readUInt16BE(at)
      units.push(hvcC.subarray(at + 2, at + 2 + length))
      at += 2 + length
    }
  }
  return { units, lengthSize }
}

/** An `hvcC` payload with `added` appended to the arrays of their types. */
export function hvcCWith(hvcC: Buffer, added: Buffer[]): Buffer {
  const arrays: Array<{ head: number; units: Buffer[] }> = []
  let at = 23
  for (let array = 0; array < hvcC[22]; array++) {
    const head = hvcC[at]
    const count = hvcC.readUInt16BE(at + 1)
    at += 3
    const units: Buffer[] = []
    for (let i = 0; i < count; i++) {
      const length = hvcC.readUInt16BE(at)
      units.push(hvcC.subarray(at + 2, at + 2 + length))
      at += 2 + length
    }
    arrays.push({ head, units })
  }
  for (const nal of added) {
    const type = nalType(nal)
    let array = arrays.find(item => (item.head & 0x3f) === type)
    if (array == null) {
      array = { head: 0x80 | type, units: [] }
      arrays.push(array)
    }
    array.units.push(nal)
  }
  const parts: Buffer[] = [hvcC.subarray(0, 22), Buffer.from([arrays.length])]
  for (const array of arrays) {
    const head = Buffer.alloc(3)
    head[0] = array.head
    head.writeUInt16BE(array.units.length, 1)
    parts.push(head)
    for (const nal of array.units) {
      const length = Buffer.alloc(2)
      length.writeUInt16BE(nal.length)
      parts.push(length, nal)
    }
  }
  return Buffer.concat(parts)
}

/**
 * The phone's init segment and its video sample entry's parameter sets, or
 * why a filler cannot share that entry.
 */
export function readSampleEntry(
  init: Buffer
): { units: Buffer[]; payload: Buffer } | string {
  const path = hvcCPath(init)
  if (path == null) return 'no hvcC in the init segment'
  const hvcC = path[path.length - 1]
  if (hvcC.header !== 8) return 'an hvcC with a large size'
  const payload = init.subarray(hvcC.start + 8, hvcC.end)
  const { units, lengthSize } = hvcCUnits(payload)
  if (lengthSize !== 4) return `NAL lengths of ${lengthSize} bytes`
  return { units, payload }
}

/** The init segment with its `hvcC` replaced and every box around it resized. */
export function initWithHvcC(init: Buffer, payload: Buffer): Buffer {
  const path = hvcCPath(init)
  if (path == null) throw new Error('no hvcC in the init segment')
  const hvcC = path[path.length - 1]
  const grow = 8 + payload.length - (hvcC.end - hvcC.start)
  const box = Buffer.alloc(8)
  box.writeUInt32BE(8 + payload.length)
  box.write('hvcC', 4, 'latin1')
  const out = Buffer.concat([
    init.subarray(0, hvcC.start),
    box,
    payload,
    init.subarray(hvcC.end)
  ])
  for (const parent of path.slice(0, -1)) {
    if (parent.header !== 8) throw new Error('a box with a large size')
    out.writeUInt32BE(parent.end - parent.start + grow, parent.start)
  }
  return out
}

/* Encoding ---------------------------------------------------------------- */

/** Encodes one black picture of the stream's shape, as Annex B units. */
export async function encodeBlackPicture(
  ffmpegPath: string,
  shape: StreamShape
): Promise<Buffer[]> {
  const { stdout } = await run(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=black:size=${shape.width}x${shape.height}:rate=1`,
      '-frames:v',
      '1',
      '-pix_fmt',
      shape.pixFmt,
      ...(shape.colorRange == null ? [] : ['-color_range', shape.colorRange]),
      ...(shape.colorSpace == null ? [] : ['-colorspace', shape.colorSpace]),
      ...(shape.colorTransfer == null
        ? []
        : ['-color_trc', shape.colorTransfer]),
      ...(shape.colorPrimaries == null
        ? []
        : ['-color_primaries', shape.colorPrimaries]),
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      'log-level=error:info=0:keyint=1:sao=0:wpp=0:slices=1:aud=0:hrd=0:vui-timing-info=0:repeat-headers=1',
      '-f',
      'hevc',
      'pipe:1'
    ],
    { encoding: 'buffer', maxBuffer: 1 << 24 }
  )
  return annexBUnits(stdout).filter(nal => {
    const type = nalType(nal)
    return type <= 31 || type === VPS || type === SPS || type === PPS
  })
}

/** Writes one filler file: black pictures, and silence after `soundOffsetSec`. */
export async function writeFiller(
  ffmpegPath: string,
  shape: StreamShape,
  picture: FillerPicture,
  plan: HolePlan,
  rate: { num: number; den: number },
  path: string
): Promise<void> {
  const start = Buffer.from([0, 0, 0, 1])
  const raw = `${path}.hevc`
  const unit = Buffer.concat([start, picture.slice])
  await writeFile(
    raw,
    Buffer.concat([
      ...picture.parameterSets.flatMap(nal => [start, nal]),
      ...Array.from({ length: plan.frames }, () => unit)
    ])
  )
  const sound = shape.sound != null && plan.soundFrames > 1 ? shape.sound : null
  const soundFirst = sound != null && sound.index < shape.videoIndex
  await run(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'hevc',
      '-framerate',
      `${rate.num}/${rate.den}`,
      '-i',
      raw,
      ...(sound == null
        ? []
        : [
            '-f',
            'lavfi',
            '-i',
            // The encoder's priming frame makes one more.
            `anullsrc=r=${sound.sampleRate}:cl=${sound.channelLayout}` +
              `:nb_samples=1024:d=${((plan.soundFrames - 1) * 1024) / sound.sampleRate}`
          ]),
      ...(soundFirst ? ['-map', '1:a', '-map', '0:v'] : ['-map', '0:v']),
      ...(sound != null && !soundFirst ? ['-map', '1:a'] : []),
      '-c:v',
      'copy',
      '-tag:v',
      'hvc1',
      // Every picture one frame long, the n-th at n frames.
      '-bsf:v',
      `setts=ts=N*${rate.den}/(${rate.num}*TB):duration=${rate.den}/(${rate.num}*TB)`,
      ...(sound == null
        ? []
        : [
            '-c:a',
            'aac',
            // Silence starts where the sound before the hole ends.
            '-bsf:a',
            `setts=ts=TS-STARTPTS+${Math.round(plan.soundOffsetSec * sound.sampleRate)}`
          ]),
      '-video_track_timescale',
      String(shape.videoTimescale),
      '-f',
      'mp4',
      path
    ],
    { maxBuffer: 1 << 22 }
  )
  await rm(raw, { force: true })
}

/**
 * The concat entries for a hole-filled live playlist, or why it could not be
 * filled, in which case the caller lists the segments as they are.
 *
 * `pieces` are the listed segments with their wall-clock starts. Each one is
 * read through `pairOf`, the init-and-segment pair the concat demuxer opens.
 * The phone's init is rewritten into `scratch` with the filler's parameter
 * sets beside its own, and every pair then uses it.
 */
export async function fillHoles(
  ffmpegPath: string,
  initPath: string,
  pieces: ReadonlyArray<{ name: string; start: number; path: string }>,
  isHole: (index: number) => boolean,
  scratch: string
): Promise<{ lines: string[]; fillers: number } | string> {
  const init = await readFile(initPath)
  const entry = readSampleEntry(init)
  if (typeof entry === 'string') return entry
  const pair = (file: string, head = initPath): string =>
    `concat:${head}|${file}`
  const shape = await probeShape(ffmpegPath, pair(pieces[0].path))
  if (typeof shape === 'string') return shape
  const picture = renumberPicture(
    await encodeBlackPicture(ffmpegPath, shape),
    entry.units
  )
  const sharedInit = join(scratch, 'init.mp4')
  await writeFile(
    sharedInit,
    initWithHvcC(init, hvcCWith(entry.payload, picture.parameterSets))
  )

  const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
  const lines = ['ffconcat version 1.0']
  let fillers = 0
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]
    lines.push(`file ${quote(pair(piece.path, sharedInit))}`)
    if (index + 1 >= pieces.length) break
    const next = pieces[index + 1]
    let plan: HolePlan | string | undefined
    let rate = { num: 30, den: 1 }
    if (isHole(index)) {
      const before = await probeSpan(ffmpegPath, pair(piece.path), shape)
      const after = await probeSpan(ffmpegPath, pair(next.path), shape)
      rate = frameRate(before.frameSec)
      plan = planHole(
        piece.start,
        before,
        next.start,
        after,
        rate,
        shape.sound?.sampleRate
      )
    }
    if (typeof plan === 'string') return plan
    if (plan == null) {
      lines.push(`duration ${(next.start - piece.start).toFixed(6)}`)
      continue
    }
    const filler = join(scratch, `filler${fillers++}.mp4`)
    await writeFiller(ffmpegPath, shape, picture, plan, rate, filler)
    lines.push(`duration ${plan.beforeSec.toFixed(6)}`)
    lines.push(`file ${quote(filler)}`)
    lines.push(`duration ${plan.fillerSec.toFixed(6)}`)
  }
  return { lines, fillers }
}
