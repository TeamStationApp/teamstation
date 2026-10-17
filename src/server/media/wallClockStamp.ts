import { encodeWallClockSei, isSliceNal } from '../../common/wallClockSei'
import {
  type Box,
  nalUnits,
  readBoxes,
  readTfhd,
  readTrun,
  type TrackRun,
  type VideoTrack,
  videoTrackOf
} from './wallClockScan'

/**
 * Stamps every frame of a fragmented MP4 with a wall clock, as TS Director's
 * programme carries one: `startWallMs` plus the frame's presentation time.
 *
 * Test tooling. It is what lets the fake broadcaster and the unit suites make
 * a stream that carries the SEI without an iPad, so it is held to the same
 * tests as what reads it.
 *
 * The copy differs from the original only in the SEI: one NAL unit inserted
 * into each video sample ahead of its first slice. Every `moof` is rewritten
 * to match (sample sizes, data offsets, and a base of the `moof` itself
 * rather than a file offset that has moved), and the indexes that point into
 * the file by position (`sidx`, `mfra`) are left out, because they would point
 * at the wrong bytes. Everything else is copied as it was.
 */
export function stampWallClock(
  input: Uint8Array,
  startWallMs: number,
  corrected = true
): Uint8Array {
  const track = videoTrackOf(input)
  if (track == null) throw new Error('no H.264 or HEVC track to stamp')
  const boxes = readBoxes(input, 0, input.length)
  const parts: Uint8Array[] = []
  for (const [i, box] of boxes.entries()) {
    if (box.type === 'sidx' || box.type === 'mfra') continue
    if (box.type === 'mdat' && boxes[i - 1]?.type === 'moof') continue
    if (box.type === 'moof') {
      parts.push(...restamp(input, box, track, startWallMs, corrected))
      continue
    }
    parts.push(input.subarray(box.start, box.end))
  }
  return concat(parts)
}

/** One run's samples as they will be written. */
interface RunOut {
  run: TrackRun
  sizes: number[]
  /** Where the run's first sample starts in the new `mdat`'s contents. */
  at: number
}

/** A `moof` and its `mdat`, rewritten with a stamp in every video sample. */
function restamp(
  input: Uint8Array,
  moof: Box,
  track: VideoTrack,
  startWallMs: number,
  corrected: boolean
): Uint8Array[] {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const data: Uint8Array[] = []
  let dataLength = 0
  const push = (bytes: Uint8Array): void => {
    data.push(bytes)
    dataLength += bytes.length
  }

  // The `moof`'s children in order, each `traf` as its own children with the
  // `trun`s still to be written once the `moof`'s size, and so the data
  // offsets, are known.
  const children: Array<Uint8Array | Array<Uint8Array | RunOut>> = []
  for (const child of readBoxes(input, moof.body, moof.end)) {
    if (child.type !== 'traf') {
      children.push(input.subarray(child.start, child.end))
      continue
    }
    const inTraf = readBoxes(input, child.body, child.end)
    const tfhdBox = inTraf.find(box => box.type === 'tfhd')
    if (tfhdBox == null) throw new Error('a traf without a tfhd')
    const tfhd = readTfhd(input, tfhdBox)
    const isVideo = tfhd.trackId === track.trackId
    const tfdt = inTraf.find(box => box.type === 'tfdt')
    let decodeTime =
      tfdt == null
        ? 0
        : input[tfdt.body] === 1
          ? Number(view.getBigUint64(tfdt.body + 4))
          : view.getUint32(tfdt.body + 4)
    const base = tfhd.baseDataOffset ?? moof.start

    const out: Array<Uint8Array | RunOut> = []
    for (const box of inTraf) {
      if (box.type === 'tfhd') {
        out.push(tfhdFromMoof(input, box))
        continue
      }
      if (box.type !== 'trun') {
        out.push(input.subarray(box.start, box.end))
        continue
      }
      const run = readTrun(input, box)
      const sizes: number[] = []
      const at = dataLength
      let offset = base + run.dataOffset
      for (const entry of run.samples) {
        const size = entry.size ?? tfhd.defaultSize ?? track.defaultSize
        const sample = input.subarray(offset, offset + size)
        offset += size
        const pts = decodeTime + (entry.compositionOffset ?? 0)
        decodeTime +=
          entry.duration ?? tfhd.defaultDuration ?? track.defaultDuration
        if (!isVideo) {
          push(sample)
          sizes.push(size)
          continue
        }
        const wallMs = Math.round(startWallMs + (pts * 1000) / track.timescale)
        const stamped = withStamp(sample, track, wallMs, corrected)
        push(stamped)
        sizes.push(stamped.length)
      }
      out.push({ run, sizes, at })
    }
    children.push(out)
  }

  // Twice: once to learn the `moof`'s size, then with the offsets in.
  const write = (moofSize: number): Uint8Array =>
    box(
      'moof',
      ...children.map(child =>
        child instanceof Uint8Array
          ? child
          : box(
              'traf',
              ...child.map(part =>
                part instanceof Uint8Array
                  ? part
                  : trun(part.run, part.sizes, moofSize + 8 + part.at)
              )
            )
      )
    )
  const moofOut = write(write(0).length)
  const header = new Uint8Array(8)
  new DataView(header.buffer).setUint32(0, 8 + dataLength)
  header.set([0x6d, 0x64, 0x61, 0x74], 4)
  return [moofOut, header, ...data]
}

/**
 * A sample with the stamp inserted before its first slice, length-prefixed
 * as the track's NAL units are.
 */
function withStamp(
  sample: Uint8Array,
  track: VideoTrack,
  wallMs: number,
  corrected: boolean
): Uint8Array {
  const sei = encodeWallClockSei(track.codec, { wallMs, corrected })
  const prefixed = new Uint8Array(track.lengthSize + sei.length)
  let length = sei.length
  for (let i = track.lengthSize - 1; i >= 0; i--) {
    prefixed[i] = length & 0xff
    length = Math.floor(length / 256)
  }
  prefixed.set(sei, track.lengthSize)
  let at = 0
  for (const nal of nalUnits(
    sample,
    { dts: 0, pts: 0, offset: 0, size: sample.length },
    track.lengthSize
  )) {
    if (isSliceNal(track.codec, nal)) break
    at = nal.byteOffset - sample.byteOffset + nal.length
  }
  return concat([sample.subarray(0, at), prefixed, sample.subarray(at)])
}

/**
 * The `tfhd` with its data based on its own `moof`: the file offset it may
 * have given has moved with everything before it.
 */
function tfhdFromMoof(input: Uint8Array, tfhd: Box): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const word = view.getUint32(tfhd.body)
  const flags = word & 0xffffff
  const body = input.subarray(tfhd.body, tfhd.end)
  const out =
    (flags & 0x1) === 0
      ? Uint8Array.from(body)
      : concat([body.subarray(0, 8), body.subarray(16)])
  new DataView(out.buffer).setUint32(0, ((word & ~0x1) | 0x020000) >>> 0)
  return box('tfhd', out)
}

/** A `trun` with every sample's size and a data offset written out. */
function trun(run: TrackRun, sizes: number[], dataOffset: number): Uint8Array {
  const flags = run.flags | 0x1 | 0x200
  const fields: number[] = []
  const signed: boolean[] = []
  const field = (value: number, isSigned = false): void => {
    fields.push(value)
    signed.push(isSigned)
  }
  field((run.version << 24) | flags)
  field(run.samples.length)
  field(dataOffset, true)
  if (run.firstSampleFlags != null) field(run.firstSampleFlags)
  for (const [i, entry] of run.samples.entries()) {
    if ((flags & 0x100) !== 0) field(entry.duration ?? 0)
    field(sizes[i])
    if ((flags & 0x400) !== 0) field(entry.flags ?? 0)
    if ((flags & 0x800) !== 0)
      field(entry.compositionOffset ?? 0, run.version !== 0)
  }
  const body = new Uint8Array(fields.length * 4)
  const view = new DataView(body.buffer)
  for (const [i, value] of fields.entries()) {
    if (signed[i]) view.setInt32(i * 4, value)
    else view.setUint32(i * 4, value >>> 0)
  }
  return box('trun', body)
}

/** A box of `type` holding `children` end to end. */
function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const body = concat(children)
  const out = new Uint8Array(8 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
