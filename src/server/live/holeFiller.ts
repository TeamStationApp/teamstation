import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { execFile } from 'child_process'
import { promisify } from 'util'

import { ffprobeFor } from '../media/ffmpeg'
import type { CodecFamily } from './decoderConfig'
import {
  Bits,
  BitWriter,
  skipProfileTierLevel,
  toPayload,
  toRbsp
} from './nalBits'

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
 * The pictures are the stream's own codec, HEVC or H.264, size and pixel
 * format, encoded here (libx265 or libx264), so they need parameter sets of
 * their own. The recording is one fragmented MP4 with one sample entry, which
 * every later `-c copy` keeps, so the filler's parameter sets (VPS, SPS and
 * PPS, or SPS and PPS) are renumbered to ids the phone does not use and added
 * beside the phone's in that one `hvcC` or `avcC`. Each slice names its own
 * PPS, so a decoder switches at the filler's first picture and back at the
 * return's keyframe, and the phone's pictures are copied untouched. A map of
 * its own behind a discontinuity for every hole would mean a recording whose
 * every FFmpeg reader stops at the first, which only a publish that cannot
 * share the init segment is worth (`toRecording`), and pictures relying on
 * parameter sets in the stream are not allowed in an `hvc1` or `avc1` track,
 * which is what Safari plays.
 *
 * Every filler picture is a keyframe, and all of them are the same few hundred
 * bytes, so only one is encoded however long the hole is (two for H.264, whose
 * consecutive IDR pictures differ in `idr_pic_id`, taken in turn), and a seek
 * into the hole lands at once.
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

/**
 * The longest gap filled where two configurations meet, in seconds. A camera
 * swapped for another can be away for most of a game, far longer than a
 * reconnect, so this only guards against timestamps that make no sense. A
 * longer one stays out of the file, and the video's row still says its span
 * (`recordingSpanSec`).
 */
export const MAX_JOIN_GAP_SEC = 6 * 60 * 60

/** What a filler has to match. */
export interface StreamShape {
  codec: CodecFamily
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
  const codec = video.codec_name
  if (codec !== 'hevc' && codec !== 'h264') return `pictures are ${codec}`
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
    codec,
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
  sampleRate?: number,
  maxSec: number = MAX_HOLE_SEC
): HolePlan | string | undefined {
  const frame = rate.den / rate.num
  const pictureEnd = start + before.videoEnd
  const returnAt = nextStart + next.videoLead
  if (returnAt - pictureEnd > maxSec) {
    return `a ${(returnAt - pictureEnd).toFixed(1)} s hole is longer than ${maxSec} s`
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

/** Encoded black pictures, renumbered to sit beside the phone's sets. */
export interface FillerPicture {
  /** The renumbered parameter sets: VPS, SPS and PPS, or SPS and PPS. */
  parameterSets: Buffer[]
  /**
   * The IDR slices, as NAL units without start codes, which the filler's
   * pictures take in turn: one for HEVC, two for H.264, whose back-to-back
   * IDR pictures must differ in `idr_pic_id`.
   */
  slices: Buffer[]
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
    slices: [
      finish(
        slice,
        Buffer.concat([sliceOut.bytes(), sliceRbsp.subarray(dataStart)])
      )
    ]
  }
}

/* H.264 parameter sets ----------------------------------------------------- */

const AVC_SPS = 7
const AVC_PPS = 8
const AVC_IDR = 5

function avcType(nal: Buffer): number {
  return nal[0] & 0x1f
}

/** Where an H.264 SPS's id is, in RBSP bits: after profile, flags and level. */
function avcSpsId(bits: Bits): { id: number; start: number; end: number } {
  bits.pos = 24
  const id = bits.ue()
  return { id, start: 24, end: bits.pos }
}

/** The ids of the H.264 parameter sets of `type` in `units`. */
function avcIdsOf(units: Buffer[], type: number): Set<number> {
  return new Set(
    units
      .filter(nal => avcType(nal) === type)
      .map(nal => {
        const bits = new Bits(toRbsp(nal.subarray(1)))
        return type === AVC_SPS ? avcSpsId(bits).id : bits.ue()
      })
  )
}

/** The lowest SPS id an H.264 stream with sets `existing` leaves free. */
export function freeAvcSpsId(existing: Buffer[]): number {
  return lowestFree(avcIdsOf(existing, AVC_SPS))
}

/**
 * Renumbers encoded black H.264 IDR pictures' SPS and PPS so they do not
 * collide with the ones in `existing`: the SPS's id, the PPS's own id and the
 * SPS it names, and each slice's `pic_parameter_set_id`. The pictures are
 * entropy coded with CAVLC, whose slice data follows the header with no
 * alignment, so everything after the rewritten id is copied bit for bit.
 */
export function renumberAvcPictures(
  units: Buffer[],
  existing: Buffer[]
): FillerPicture {
  const sps = units.find(nal => avcType(nal) === AVC_SPS)
  const pps = units.find(nal => avcType(nal) === AVC_PPS)
  const slices = units.filter(nal => avcType(nal) >= 1 && avcType(nal) <= 5)
  if (
    sps == null ||
    pps == null ||
    slices.length === 0 ||
    slices.some(nal => avcType(nal) !== AVC_IDR)
  ) {
    throw new Error('the filler pictures are not IDR slices with their sets')
  }
  const spsId = lowestFree(avcIdsOf(existing, AVC_SPS))
  const ppsId = lowestFree(avcIdsOf(existing, AVC_PPS))
  if (spsId > 31 || ppsId > 255)
    throw new Error('no parameter set ids are free')
  const finish = (nal: Buffer, out: BitWriter): Buffer =>
    Buffer.concat([nal.subarray(0, 1), toPayload(out.bytes())])

  const spsBits = new Bits(toRbsp(sps.subarray(1)))
  const spsHead = avcSpsId(spsBits)
  const spsOut = new BitWriter()
  spsOut.copy(spsBits, 0, spsHead.start)
  spsOut.ue(spsId)
  spsOut.copy(spsBits, spsHead.end, spsBits.stopBit())
  spsOut.align()

  const ppsBits = new Bits(toRbsp(pps.subarray(1)))
  ppsBits.ue()
  ppsBits.ue()
  if (ppsBits.u(1) === 1) throw new Error('the filler PPS uses CABAC')
  const ppsOut = new BitWriter()
  ppsOut.ue(ppsId)
  ppsOut.ue(spsId)
  ppsOut.copy(ppsBits, ppsBits.pos - 1, ppsBits.stopBit())
  ppsOut.align()

  return {
    parameterSets: [finish(sps, spsOut), finish(pps, ppsOut)],
    slices: slices.map(slice => {
      const bits = new Bits(toRbsp(slice.subarray(1)))
      if (bits.ue() !== 0) throw new Error('the filler has several slices')
      if (bits.ue() % 5 !== 2) throw new Error('the filler slice is not intra')
      const idStart = bits.pos
      bits.ue()
      const out = new BitWriter()
      out.copy(bits, 0, idStart)
      out.ue(ppsId)
      out.copy(bits, bits.pos, bits.stopBit())
      out.align()
      return finish(slice, out)
    })
  }
}

/* The sample entry -------------------------------------------------------- */

export interface Box {
  type: string
  start: number
  end: number
  header: number
}

export function boxesIn(data: Buffer, start: number, end: number): Box[] {
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

/**
 * The chain of boxes from `moov` down to the video track's decoder
 * configuration: the first `stsd` entry of one of `entries`, then its `config`.
 */
function sampleConfigPath(
  init: Buffer,
  entries: readonly string[],
  config: string
): Box[] | undefined {
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
    const entry = boxesIn(init, parent.start + 16, parent.end).find(box =>
      entries.includes(box.type)
    )
    if (entry == null) continue
    // A visual sample entry's own fields come before its child boxes.
    const found = boxesIn(init, entry.start + 8 + 78, entry.end).find(
      box => box.type === config
    )
    if (found == null) continue
    return [...path, entry, found]
  }
  return undefined
}

/** The chain of boxes from `moov` down to the video track's `hvcC`. */
export function hvcCPath(init: Buffer): Box[] | undefined {
  return sampleConfigPath(init, ['hvc1', 'hev1'], 'hvcC')
}

/** The chain of boxes from `moov` down to the video track's `avcC`. */
export function avcCPath(init: Buffer): Box[] | undefined {
  return sampleConfigPath(init, ['avc1', 'avc3'], 'avcC')
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
 * The SPS and PPS units of an AVCDecoderConfigurationRecord, its NAL length
 * size, and where what follows them starts: five bytes of profile, level and
 * length size, a count of SPS (low five bits) each behind a 16-bit length,
 * then a count of PPS, the same. What follows them, the high profiles'
 * chroma and bit depth, repeats what the SPS says.
 */
export function avcCUnits(avcC: Buffer): {
  sps: Buffer[]
  pps: Buffer[]
  lengthSize: number
  rest: number
} {
  const lists: Buffer[][] = []
  let at = 5
  for (const mask of [0x1f, 0xff]) {
    if (at >= avcC.length) throw new RangeError('a short avcC')
    const count = avcC[at++] & mask
    const units: Buffer[] = []
    for (let i = 0; i < count; i++) {
      if (at + 2 > avcC.length) throw new RangeError('a short avcC')
      const length = avcC.readUInt16BE(at)
      if (at + 2 + length > avcC.length) throw new RangeError('a short avcC')
      units.push(avcC.subarray(at + 2, at + 2 + length))
      at += 2 + length
    }
    lists.push(units)
  }
  return {
    sps: lists[0],
    pps: lists[1],
    lengthSize: (avcC[4] & 3) + 1,
    rest: at
  }
}

/** An `avcC` payload with `added` SPS and PPS appended to their lists. */
export function avcCWith(avcC: Buffer, added: Buffer[]): Buffer {
  const { sps, pps, rest } = avcCUnits(avcC)
  const allSps = [...sps, ...added.filter(nal => avcType(nal) === AVC_SPS)]
  const allPps = [...pps, ...added.filter(nal => avcType(nal) === AVC_PPS)]
  if (allSps.length > 31 || allPps.length > 255) {
    throw new Error('too many parameter sets for an avcC')
  }
  const list = (units: Buffer[]): Buffer[] =>
    units.flatMap(nal => {
      const length = Buffer.alloc(2)
      length.writeUInt16BE(nal.length)
      return [length, nal]
    })
  return Buffer.concat([
    avcC.subarray(0, 5),
    Buffer.from([0xe0 | allSps.length]),
    ...list(allSps),
    Buffer.from([allPps.length]),
    ...list(allPps),
    avcC.subarray(rest)
  ])
}

/** The video sample entry's decoder configuration a filler shares. */
export interface SampleEntry {
  family: CodecFamily
  /** Its parameter sets. */
  units: Buffer[]
  /** The `hvcC` or `avcC` payload. */
  payload: Buffer
}

/** The chain of boxes from `moov` down to the `hvcC` or the `avcC`. */
function configPath(init: Buffer): Box[] | undefined {
  return hvcCPath(init) ?? avcCPath(init)
}

/**
 * The phone's init segment and its video sample entry's parameter sets, or
 * why a filler cannot share that entry.
 */
export function readSampleEntry(init: Buffer): SampleEntry | string {
  const path = configPath(init)
  if (path == null) return 'no hvcC or avcC in the init segment'
  const config = path[path.length - 1]
  if (config.header !== 8) return `an ${config.type} with a large size`
  const payload = init.subarray(config.start + 8, config.end)
  if (config.type === 'hvcC') {
    const { units, lengthSize } = hvcCUnits(payload)
    if (lengthSize !== 4) return `NAL lengths of ${lengthSize} bytes`
    return { family: 'hevc', units, payload }
  }
  const { sps, pps, lengthSize } = avcCUnits(payload)
  if (lengthSize !== 4) return `NAL lengths of ${lengthSize} bytes`
  return { family: 'h264', units: [...sps, ...pps], payload }
}

/**
 * The init segment with its `hvcC` or `avcC` replaced and every box around it
 * resized.
 */
export function initWithConfig(init: Buffer, payload: Buffer): Buffer {
  const path = configPath(init)
  if (path == null) throw new Error('no hvcC or avcC in the init segment')
  const config = path[path.length - 1]
  const grow = 8 + payload.length - (config.end - config.start)
  const box = Buffer.alloc(8)
  box.writeUInt32BE(8 + payload.length)
  box.write(config.type, 4, 'latin1')
  const out = Buffer.concat([
    init.subarray(0, config.start),
    box,
    payload,
    init.subarray(config.end)
  ])
  for (const parent of path.slice(0, -1)) {
    if (parent.header !== 8) throw new Error('a box with a large size')
    out.writeUInt32BE(parent.end - parent.start + grow, parent.start)
  }
  return out
}

/* Encoding ---------------------------------------------------------------- */

/** FFmpeg's arguments for black pictures of the stream's size and colour. */
function blackSource(shape: StreamShape, frames: number): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=black:size=${shape.width}x${shape.height}:rate=1`,
    '-frames:v',
    String(frames),
    '-pix_fmt',
    shape.pixFmt,
    ...(shape.colorRange == null ? [] : ['-color_range', shape.colorRange]),
    ...(shape.colorSpace == null ? [] : ['-colorspace', shape.colorSpace]),
    ...(shape.colorTransfer == null ? [] : ['-color_trc', shape.colorTransfer]),
    ...(shape.colorPrimaries == null
      ? []
      : ['-color_primaries', shape.colorPrimaries])
  ]
}

/** Encodes one black picture of the stream's shape, as Annex B units. */
export async function encodeBlackPicture(
  ffmpegPath: string,
  shape: StreamShape
): Promise<Buffer[]> {
  const { stdout } = await run(
    ffmpegPath,
    [
      ...blackSource(shape, 1),
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

/** libx264's names for the H.264 profiles it makes, by `profile_idc`. */
const X264_PROFILES: Record<number, string> = {
  66: 'baseline',
  77: 'main',
  100: 'high',
  110: 'high10',
  122: 'high422',
  244: 'high444'
}

/**
 * The profile and level an `avcC` declares, as libx264 takes them: the
 * filler is held to them so it asks no more of a decoder than the stream.
 */
export function x264ProfileOf(
  avcC: Buffer
): { profile: string; level: string } | undefined {
  const profile = X264_PROFILES[avcC[1]]
  if (profile == null) return undefined
  const level = avcC[3] === 9 ? '1b' : (avcC[3] / 10).toFixed(1)
  return { profile, level }
}

/**
 * Encodes two black IDR pictures of the stream's shape with libx264, as
 * Annex B units: CAVLC, one slice, no B pictures, at the stream's profile and
 * level, and with `spsId` as its SPS and PPS ids where the stream leaves it
 * free. SEI is left out.
 */
export async function encodeBlackAvcPictures(
  ffmpegPath: string,
  shape: StreamShape,
  avcC: Buffer,
  spsId: number
): Promise<Buffer[]> {
  const target = x264ProfileOf(avcC)
  if (target == null) {
    throw new Error(`H.264 profile ${avcC[1]} is not one libx264 makes`)
  }
  const { profile, level } = target
  const { stdout } = await run(
    ffmpegPath,
    [
      ...blackSource(shape, 2),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-profile:v',
      profile,
      '-x264-params',
      `log-level=error:keyint=1:min-keyint=1:scenecut=0:bframes=0:cabac=0:slices=1:aud=0:level=${level}:sps-id=${spsId}`,
      '-f',
      'h264',
      'pipe:1'
    ],
    { encoding: 'buffer', maxBuffer: 1 << 24 }
  )
  return annexBUnits(stdout).filter(nal => {
    const type = avcType(nal)
    return (type >= 1 && type <= 5) || type === AVC_SPS || type === AVC_PPS
  })
}

/** The filler's black pictures, renumbered beside the sets in `entry`. */
export async function fillerPicture(
  ffmpegPath: string,
  shape: StreamShape,
  entry: SampleEntry
): Promise<FillerPicture> {
  if (entry.family === 'hevc') {
    return renumberPicture(
      await encodeBlackPicture(ffmpegPath, shape),
      entry.units
    )
  }
  return renumberAvcPictures(
    await encodeBlackAvcPictures(
      ffmpegPath,
      shape,
      entry.payload,
      freeAvcSpsId(entry.units)
    ),
    entry.units
  )
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
  const format = shape.codec === 'hevc' ? 'hevc' : 'h264'
  const raw = `${path}.${format}`
  const units = picture.slices.map(slice => Buffer.concat([start, slice]))
  await writeFile(
    raw,
    Buffer.concat([
      ...picture.parameterSets.flatMap(nal => [start, nal]),
      ...Array.from({ length: plan.frames }, (_, i) => units[i % units.length])
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
      format,
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
      shape.codec === 'hevc' ? 'hvc1' : 'avc1',
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
 *
 * `joinAt` is where the next configuration starts on the same clock, when one
 * follows: its first picture opens where this list stops, so the gap up to it
 * is filled after the last piece, as a hole is.
 */
export async function fillHoles(
  ffmpegPath: string,
  initPath: string,
  pieces: ReadonlyArray<{ name: string; start: number; path: string }>,
  isHole: (index: number) => boolean,
  scratch: string,
  joinAt?: number
): Promise<{ lines: string[]; fillers: number } | string> {
  const init = await readFile(initPath)
  const entry = readSampleEntry(init)
  if (typeof entry === 'string') return entry
  const pair = (file: string, head = initPath): string =>
    `concat:${head}|${file}`
  const shape = await probeShape(ffmpegPath, pair(pieces[0].path))
  if (typeof shape === 'string') return shape
  const picture = await fillerPicture(ffmpegPath, shape, entry)
  const sharedInit = join(scratch, 'init.mp4')
  await writeFile(
    sharedInit,
    initWithConfig(
      init,
      entry.family === 'hevc'
        ? hvcCWith(entry.payload, picture.parameterSets)
        : avcCWith(entry.payload, picture.parameterSets)
    )
  )

  const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
  const lines = ['ffconcat version 1.0']
  let fillers = 0
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]
    lines.push(`file ${quote(pair(piece.path, sharedInit))}`)
    const next = pieces.at(index + 1)
    const nextStart = next?.start ?? joinAt
    if (nextStart == null) break
    let plan: HolePlan | string | undefined
    let rate = { num: 30, den: 1 }
    if (isHole(index)) {
      const before = await probeSpan(ffmpegPath, pair(piece.path), shape)
      const after =
        next == null
          ? { videoEnd: 0, videoLead: 0, frameSec: before.frameSec }
          : await probeSpan(ffmpegPath, pair(next.path), shape)
      rate = frameRate(before.frameSec)
      plan = planHole(
        piece.start,
        before,
        nextStart,
        after,
        rate,
        shape.sound?.sampleRate,
        next == null ? MAX_JOIN_GAP_SEC : MAX_HOLE_SEC
      )
    }
    if (typeof plan === 'string') return plan
    if (plan == null) {
      lines.push(`duration ${(nextStart - piece.start).toFixed(6)}`)
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
