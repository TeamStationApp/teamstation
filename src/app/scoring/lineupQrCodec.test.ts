import { expect } from 'chai'
import { deflateSync } from 'fflate'
import { describe, it } from 'mocha'
import { base64 } from 'rfc4648'

import { utf8 } from '../walkup/localFileId'
import {
  lineupQrFixture1,
  lineupQrFixture2,
  lineupQrFixture3,
  lineupQrFixture4
} from './lineupQr.fixtures'
import {
  decodeLineupQr,
  encodeLineupQr,
  fromUtf8,
  type GameChangerLineup,
  LineupQrError,
  type LineupQrErrorReason
} from './lineupQrCodec'

const packed = (json: string): string =>
  base64.stringify(deflateSync(utf8(json)))
const reason = (text: string): LineupQrErrorReason | undefined => {
  try {
    decodeLineupQr(text)
  } catch (error) {
    expect(error).instanceOf(LineupQrError)
    return (error as LineupQrError).reason
  }
  return undefined
}
const player = {
  i: '00000000-0000-4000-8000-000000000000',
  f: 'Mookie',
  l: 'Betts',
  n: '1',
  p: 6
}

describe('lineup QR codec', function () {
  it('decodes the text another encoder made of each GameChanger lineup', function () {
    for (const fixture of [
      lineupQrFixture1,
      lineupQrFixture2,
      lineupQrFixture3,
      lineupQrFixture4
    ])
      expect(decodeLineupQr(fixture.text)).deep.equals(fixture.lineup)
  })

  it('reads back what it encodes, names in every script included', function () {
    const lineup: GameChangerLineup = {
      ...lineupQrFixture4.lineup,
      h: [
        { ...player, f: 'Pedro', l: 'Peña' },
        { ...player, f: 'Minh', l: 'Nguyễn', n: '12', p: 12 },
        { ...player, f: '翔平', l: '大谷', n: '17', p: 11 },
        { ...player, f: 'Ace', l: '⚾️', n: '', p: 9 }
      ]
    }
    expect(decodeLineupQr(encodeLineupQr(lineup))).deep.equals(lineup)
  })

  it('keeps only the keys GameChanger reads, in its order', function () {
    const text = encodeLineupQr({
      ...lineupQrFixture1.lineup,
      h: [{ ...player, extra: true } as unknown as typeof player],
      n: []
    })
    expect(decodeLineupQr(text).h).deep.equals([player])
  })

  it('accepts whitespace around the text and ignores unknown keys', function () {
    const text = packed(
      JSON.stringify({ ...lineupQrFixture2.lineup, v: 3, x: { y: 1 } })
    )
    expect(decodeLineupQr(`  ${text}\n`)).deep.includes({
      e: lineupQrFixture2.lineup.e
    })
  })

  it('names text that is not a lineup code', function () {
    expect(reason('hello')).equals('notLineup')
    expect(reason(base64.stringify(utf8('not deflate at all, really')))).equals(
      'notLineup'
    )
    expect(reason(packed('{"h": ['))).equals('notLineup')
    expect(
      reason(base64.stringify(deflateSync(new Uint8Array([0xff]))))
    ).equals('notLineup')
  })

  it('names a code that is not shaped like a lineup', function () {
    expect(reason(packed('{"e":"x","t":"y"}'))).equals('wrongShape')
    expect(
      reason(
        packed(
          JSON.stringify({ e: 'x', t: 'y', n: [], h: [{ ...player, n: 7 }] })
        )
      )
    ).equals('wrongShape')
    const { p, ...noPosition } = player
    expect(p).equals(6)
    expect(
      reason(packed(JSON.stringify({ e: 'x', t: 'y', n: [], h: [noPosition] })))
    ).equals('wrongShape')
    expect(
      reason(
        packed(
          JSON.stringify({
            e: 'x',
            t: 'y',
            n: [{ ...player, f: ' ', l: '' }],
            h: []
          })
        )
      )
    ).equals('wrongShape')
  })

  it('names a code with no players', function () {
    expect(reason(packed('{"e":"x","t":"y","h":[],"n":[]}'))).equals('empty')
  })

  it('refuses malformed UTF-8', function () {
    expect(() => fromUtf8(new Uint8Array([0xc3]))).throws('Malformed UTF-8')
    expect(() => fromUtf8(new Uint8Array([0xe2, 0x41, 0x41]))).throws(
      'Malformed UTF-8'
    )
    expect(() => fromUtf8(new Uint8Array([0xf8, 0x80]))).throws(
      'Malformed UTF-8'
    )
    expect(fromUtf8(utf8('é€😀'))).equals('é€😀')
  })
})
