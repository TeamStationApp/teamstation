/**
 * Test fixtures: a fragmented HEVC init segment, and media segments whose
 * first picture carries the wall-clock SEI the way a publisher writes it — a
 * prefix SEI NAL unit ahead of the picture (`src/common/wallClockSei.ts`).
 * Shared by the segment clock's tests and the ingest's.
 */

import { encodeWallClockSei } from '../../common/wallClockSei'

export function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

/**
 * A prefix SEI NAL unit holding one frame's wall clock, on the server's clock
 * unless `corrected` is false.
 */
export function wallClockNal(wallMs: number, corrected = true): Buffer {
  return Buffer.from(encodeWallClockSei('hevc', { wallMs, corrected }))
}

/** An IDR slice's worth of bytes, which no SEI reader should look inside. */
export const IDR_SLICE = Buffer.from([19 << 1, 1, 0xaf, 0, 0, 1, 0x42])

/** An init segment with one HEVC video track (id 1) at `timescale`, 4-byte NAL lengths. */
export function hevcInit(timescale = 90_000): Buffer {
  const tkhd = Buffer.alloc(16)
  tkhd.writeUInt32BE(1, 12)
  const mdhd = Buffer.alloc(16)
  mdhd.writeUInt32BE(timescale, 12)
  const hdlr = Buffer.alloc(12)
  hdlr.write('vide', 8, 'latin1')
  const hvcC = Buffer.alloc(23)
  hvcC[0] = 1
  hvcC[21] = 0xf0 | 3
  // stsd's version, flags and entry count, then one `hvc1` sample entry: 78
  // bytes of its own, and its `hvcC`.
  const stsdHead = Buffer.alloc(8)
  stsdHead.writeUInt32BE(1, 4)
  const hvc1 = box('hvc1', Buffer.concat([Buffer.alloc(78), box('hvcC', hvcC)]))
  const sound = Buffer.alloc(16)
  sound.writeUInt32BE(2, 12)
  const soundMdhd = Buffer.alloc(16)
  soundMdhd.writeUInt32BE(48_000, 12)
  const soundHdlr = Buffer.alloc(12)
  soundHdlr.write('soun', 8, 'latin1')
  return Buffer.concat([
    box('ftyp', Buffer.alloc(8)),
    box(
      'moov',
      Buffer.concat([
        box(
          'trak',
          Buffer.concat([
            box('tkhd', tkhd),
            box(
              'mdia',
              Buffer.concat([
                box('mdhd', mdhd),
                box('hdlr', hdlr),
                box(
                  'minf',
                  box('stbl', box('stsd', Buffer.concat([stsdHead, hvc1])))
                )
              ])
            )
          ])
        ),
        box(
          'trak',
          Buffer.concat([
            box('tkhd', sound),
            box(
              'mdia',
              Buffer.concat([box('mdhd', soundMdhd), box('hdlr', soundHdlr)])
            )
          ])
        )
      ])
    )
  ])
}

/**
 * One media segment as the HLS writer leaves it: a `sidx`, a `moof` whose
 * sound run comes first and whose video run's first sample is `nals`
 * (length-prefixed), at decode time `decodeSec` with a composition offset of
 * `compositionSec`, and the `mdat`.
 */
export function hevcSegment(
  decodeSec: number,
  nals: Buffer[],
  { timescale = 90_000, compositionSec = 0 } = {}
): Buffer {
  const sample = Buffer.concat(
    nals.flatMap(nal => {
      const length = Buffer.alloc(4)
      length.writeUInt32BE(nal.length, 0)
      return [length, nal]
    })
  )
  const sound = Buffer.alloc(4)
  const sidx = Buffer.alloc(32)
  sidx[0] = 1
  sidx.writeUInt32BE(timescale, 8)
  sidx.writeBigUInt64BE(BigInt(Math.round(decodeSec * timescale)), 12)

  const traf = (
    trackId: number,
    decode: bigint,
    size: number,
    offset: number,
    composition: number
  ): Buffer => {
    const tfhd = Buffer.alloc(8)
    tfhd.writeUInt32BE(0x020000, 0)
    tfhd.writeUInt32BE(trackId, 4)
    const tfdt = Buffer.alloc(12)
    tfdt[0] = 1
    tfdt.writeBigUInt64BE(decode, 4)
    const trun = Buffer.alloc(20)
    trun[0] = 1
    trun.writeUInt32BE(0x001 | 0x200 | 0x800, 0)
    trun[0] = 1
    trun.writeUInt32BE(1, 4)
    trun.writeInt32BE(offset, 8)
    trun.writeUInt32BE(size, 12)
    trun.writeInt32BE(composition, 16)
    return box(
      'traf',
      Buffer.concat([box('tfhd', tfhd), box('tfdt', tfdt), box('trun', trun)])
    )
  }
  const build = (soundOffset: number, videoOffset: number): Buffer =>
    box(
      'moof',
      Buffer.concat([
        box('mfhd', Buffer.alloc(8)),
        traf(
          2,
          BigInt(Math.round(decodeSec * 48_000)),
          sound.length,
          soundOffset,
          0
        ),
        traf(
          1,
          BigInt(Math.round(decodeSec * timescale)),
          sample.length,
          videoOffset,
          Math.round(compositionSec * timescale)
        )
      ])
    )
  const size = build(0, 0).length
  const moof = build(size + 8, size + 8 + sound.length)
  return Buffer.concat([
    box('sidx', sidx),
    moof,
    box('mdat', Buffer.concat([sound, sample]))
  ])
}
