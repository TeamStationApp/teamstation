import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  avcCUnits,
  avcCWith,
  encodeBlackAvcPictures,
  freeAvcSpsId,
  readSampleEntry,
  renumberAvcPictures,
  x264ProfileOf
} from './holeFiller'
import { Bits, BitWriter, toPayload, toRbsp } from './nalBits'

const hex = (text: string): Buffer => Buffer.from(text, 'hex')

/**
 * Two black 64×64 IDR pictures as `encodeBlackAvcPictures` has libx264 make
 * them (CAVLC, `sps-id=0`), the SPS and PPS repeated before the second.
 */
const FILLER = [
  '6742c01edc426c044000000300400000030083c58be0',
  '68ce0fc8',
  '6588843a2628000902c9c9c9d75d75d75d75d75d75e0',
  '6742c01edc426c044000000300400000030083c58be0',
  '68ce0fc8',
  '658882017a24c28000fefc93c9c9d75d75d75d75d75d75e0'
].map(hex)

/** A High profile phone's SPS and PPS, both id 0, its PPS with CABAC. */
const PHONE_SPS = hex('6764000aacd9496c0440000003004000000f03c4896580')
const PHONE_PPS = hex('68ebe3cb22c0')

/** An `avcC` of the phone's sets, with the High profile's trailing fields. */
function phoneAvcC(): Buffer {
  return Buffer.concat([
    Buffer.from([1, 0x64, 0, 0x0a, 0xff, 0xe1, 0, PHONE_SPS.length]),
    PHONE_SPS,
    Buffer.from([1, 0, PHONE_PPS.length]),
    PHONE_PPS,
    Buffer.from([0xfd, 0xf8, 0xf8, 0])
  ])
}

/** The ids an H.264 unit names: an SPS its own; a PPS its own and its SPS's; a slice its PPS's. */
function idsIn(nal: Buffer): number[] {
  const bits = new Bits(toRbsp(nal.subarray(1)))
  const type = nal[0] & 0x1f
  if (type === 7) {
    bits.skip(24)
    return [bits.ue()]
  }
  if (type === 8) return [bits.ue(), bits.ue()]
  bits.ue()
  bits.ue()
  return [bits.ue()]
}

describe('black H.264 filler pictures', function () {
  it('renumbers the filler’s SPS and PPS to ids the stream does not use', function () {
    const picture = renumberAvcPictures(FILLER, [PHONE_SPS, PHONE_PPS])
    const [sps, pps] = picture.parameterSets
    expect(sps[0]).equals(0x67)
    expect(pps[0]).equals(0x68)
    expect(idsIn(sps)).deep.equals([1])
    // Its own id, and the SPS it names.
    expect(idsIn(pps)).deep.equals([1, 1])
    expect(idsIn(PHONE_SPS)).deep.equals([0])
    expect(idsIn(PHONE_PPS)).deep.equals([0, 0])
  })

  it('rewrites each slice’s pic_parameter_set_id and keeps the rest of it', function () {
    const picture = renumberAvcPictures(FILLER, [PHONE_SPS, PHONE_PPS])
    expect(picture.slices.length).equals(2)
    for (const slice of picture.slices) {
      expect(slice[0]).equals(0x65)
      expect(idsIn(slice)).deep.equals([1])
    }
    // Renumbered back to the ids it was made with, every unit is as encoded.
    const back = renumberAvcPictures(
      [...picture.parameterSets, ...picture.slices],
      []
    )
    expect(
      [...back.parameterSets, ...back.slices].map(nal => nal.toString('hex'))
    ).deep.equals(
      [FILLER[0], FILLER[1], FILLER[2], FILLER[5]].map(nal =>
        nal.toString('hex')
      )
    )
  })

  it('takes the lowest free SPS id and PPS id separately', function () {
    const spsOne = renumberAvcPictures(FILLER, [PHONE_SPS]).parameterSets[0]
    const picture = renumberAvcPictures(FILLER, [PHONE_SPS, spsOne])
    expect(idsIn(picture.parameterSets[0])).deep.equals([2])
    // No PPS was in use, so the PPS keeps id 0 and names SPS 2.
    expect(idsIn(picture.parameterSets[1])).deep.equals([0, 2])
    expect(idsIn(picture.slices[0])).deep.equals([0])
    expect(freeAvcSpsId([PHONE_SPS, spsOne, PHONE_PPS])).equals(2)
    expect(freeAvcSpsId([])).equals(0)
  })

  it('says when every SPS id is taken', function () {
    const existing: Buffer[] = []
    for (let id = 0; id < 32; id++) {
      existing.push(renumberAvcPictures(FILLER, existing).parameterSets[0])
    }
    expect(existing.map(nal => idsIn(nal)[0])).deep.equals(
      Array.from({ length: 32 }, (_, id) => id)
    )
    expect(() => renumberAvcPictures(FILLER, existing)).throws(
      /no parameter set ids are free/
    )
  })

  it('refuses pictures it cannot renumber', function () {
    expect(() => renumberAvcPictures([], [])).throws(/IDR slices/)
    // A non-IDR slice.
    const notIdr = Buffer.from(FILLER[2])
    notIdr[0] = 0x61
    expect(() =>
      renumberAvcPictures([FILLER[0], FILLER[1], notIdr], [])
    ).throws(/IDR slices/)
    // An IDR slice that is not the picture's first, and one that is not intra.
    const slice = (...codes: number[]): Buffer => {
      const out = new BitWriter()
      for (const code of codes) out.ue(code)
      out.align()
      return Buffer.concat([Buffer.from([0x65]), toPayload(out.bytes())])
    }
    expect(() =>
      renumberAvcPictures([FILLER[0], FILLER[1], slice(1, 7, 0)], [])
    ).throws(/several slices/)
    expect(() =>
      renumberAvcPictures([FILLER[0], FILLER[1], slice(0, 5, 0)], [])
    ).throws(/not intra/)
    expect(
      idsIn(
        renumberAvcPictures([FILLER[0], FILLER[1], slice(0, 7, 0)], [PHONE_PPS])
          .slices[0]
      )
    ).deep.equals([1])
    // A PPS with CABAC, whose slice data is aligned after the header.
    expect(() =>
      renumberAvcPictures([FILLER[0], PHONE_PPS, FILLER[2]], [])
    ).throws(/CABAC/)
  })

  it('carries the stream’s sets and the filler’s in one avcC, keeping its trailing fields', function () {
    const avcC = phoneAvcC()
    const picture = renumberAvcPictures(FILLER, [PHONE_SPS, PHONE_PPS])
    const both = avcCWith(avcC, picture.parameterSets)
    const { sps, pps, lengthSize, rest } = avcCUnits(both)
    expect(sps.map(nal => nal.toString('hex'))).deep.equals([
      PHONE_SPS.toString('hex'),
      picture.parameterSets[0].toString('hex')
    ])
    expect(pps.map(nal => nal.toString('hex'))).deep.equals([
      PHONE_PPS.toString('hex'),
      picture.parameterSets[1].toString('hex')
    ])
    expect(lengthSize).equals(4)
    expect([...both.subarray(0, 5)]).deep.equals([...avcC.subarray(0, 5)])
    expect(both[5]).equals(0xe2)
    expect([...both.subarray(rest)]).deep.equals([0xfd, 0xf8, 0xf8, 0])
  })

  it('reads a short avcC as broken, and refuses one that would hold too many sets', function () {
    expect(() => avcCUnits(Buffer.from([1, 0x64, 0, 0x0a, 0xff]))).throws(
      /short avcC/
    )
    expect(() =>
      avcCUnits(Buffer.from([1, 0x64, 0, 0x0a, 0xff, 0xe1, 0, 9, 0x67]))
    ).throws(/short avcC/)
    expect(() =>
      avcCUnits(Buffer.from([1, 0x64, 0, 0x0a, 0xff, 0xe1, 0]))
    ).throws(/short avcC/)
    const full = avcCWith(
      phoneAvcC(),
      Array.from({ length: 30 }, () => PHONE_SPS)
    )
    expect(avcCUnits(full).sps.length).equals(31)
    expect(() => avcCWith(full, [PHONE_SPS])).throws(/too many/)
  })

  it('holds the filler to the stream’s profile and level', function () {
    expect(x264ProfileOf(Buffer.from([1, 100, 0, 40]))).deep.equals({
      profile: 'high',
      level: '4.0'
    })
    expect(x264ProfileOf(Buffer.from([1, 77, 0, 31]))).deep.equals({
      profile: 'main',
      level: '3.1'
    })
    expect(x264ProfileOf(Buffer.from([1, 66, 0xc0, 9]))).deep.equals({
      profile: 'baseline',
      level: '1b'
    })
    // Extended, which libx264 does not make.
    expect(x264ProfileOf(Buffer.from([1, 88, 0, 30]))).equals(undefined)
  })

  it('makes no filler for a profile libx264 does not make', async function () {
    const shape = {
      codec: 'h264' as const,
      width: 64,
      height: 64,
      pixFmt: 'yuv420p',
      videoIndex: 0,
      videoTimescale: 15360
    }
    let said = ''
    await encodeBlackAvcPictures(
      'ffmpeg',
      shape,
      Buffer.from([1, 88, 0, 30]),
      0
    ).catch((error: unknown) => (said = String(error)))
    expect(said).equals('Error: H.264 profile 88 is not one libx264 makes')
  })

  it('reads an avc1 init’s sample entry as H.264', function () {
    const avcC = phoneAvcC()
    const box = (type: string, ...children: Buffer[]): Buffer => {
      const body = Buffer.concat(children)
      const head = Buffer.alloc(8)
      head.writeUInt32BE(8 + body.length)
      head.write(type, 4, 'latin1')
      return Buffer.concat([head, body])
    }
    const init = box(
      'moov',
      box(
        'trak',
        box(
          'mdia',
          box(
            'minf',
            box(
              'stbl',
              box(
                'stsd',
                Buffer.alloc(8),
                box('avc1', Buffer.alloc(78), box('avcC', avcC))
              )
            )
          )
        )
      )
    )
    const entry = readSampleEntry(init)
    if (typeof entry === 'string') throw new Error(entry)
    expect(entry.family).equals('h264')
    expect(entry.payload.equals(avcC)).equals(true)
    expect(entry.units.map(nal => nal.toString('hex'))).deep.equals([
      PHONE_SPS.toString('hex'),
      PHONE_PPS.toString('hex')
    ])
    const shortInit = Buffer.from(init)
    shortInit[init.indexOf(avcC) + 4] = 0xfd
    expect(readSampleEntry(shortInit)).equals('NAL lengths of 2 bytes')
  })
})
