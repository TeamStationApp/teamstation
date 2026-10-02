import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  bucketSize,
  equalBytes,
  fromUtf8,
  join,
  lp,
  pad,
  SMALLEST_BUCKET,
  u64,
  unpad,
  utf8
} from './bytes'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const fromHex = (text: string): Uint8Array => Buffer.from(text, 'hex')

describe('chatCrypto bytes', () => {
  it('lp: frozen vectors', () => {
    expect(hex(lp('ab'))).equals('000000026162')
    expect(hex(lp(''))).equals('00000000')
    expect(hex(lp(Uint8Array.of(1, 2, 3)))).equals('00000003010203')
    expect(hex(lp('é🎉'))).equals('00000006c3a9f09f8e89')
    expect(hex(lp(new Uint8Array(0x10304)).subarray(0, 4))).equals('00010304')
  })

  it('u64: frozen vectors', () => {
    expect(hex(u64(0))).equals('0000000000000000')
    expect(hex(u64(1))).equals('0000000000000001')
    expect(hex(u64(2 ** 53 - 1))).equals('001fffffffffffff')
    expect(hex(u64(0x0102030405060708n))).equals('0102030405060708')
    expect(hex(u64(1234567890123))).equals('0000011f71fb04cb')
    expect(hex(u64((1n << 64n) - 1n))).equals('ffffffffffffffff')
  })

  it('u64 refuses what is not an unsigned whole number', () => {
    for (const bad of [-1, 1.5, 2 ** 53, Number.NaN]) {
      expect(() => u64(bad)).throws(RangeError)
    }
    expect(() => u64(-1n)).throws(RangeError)
    expect(() => u64(1n << 64n)).throws(RangeError)
  })

  it('join puts the parts end to end', () => {
    expect(
      hex(join(Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3)))
    ).equals('010203')
    expect(join().length).equals(0)
  })

  it('utf8 agrees with Node, lone surrogates included', () => {
    const samples = [
      '',
      'plain',
      'é',
      'ñandú',
      '€',
      '🎉👍🏽',
      '👨‍👩‍👧‍👦',
      '\u0000\u007f\u0080߿ࠀ￿',
      'a\ud800b',
      '\udc00',
      'end\ud83d'
    ]
    for (const text of samples) {
      expect(hex(utf8(text)), JSON.stringify(text)).equals(
        Buffer.from(text, 'utf8').toString('hex')
      )
    }
  })

  it('fromUtf8 reads back what utf8 wrote', () => {
    for (const text of ['', 'abc', 'é€🎉', '👨‍👩‍👧‍👦', '\u0000￿\u{10ffff}']) {
      expect(fromUtf8(utf8(text))).equals(text)
    }
  })

  it('fromUtf8 refuses bytes that are not UTF-8', () => {
    const bad = [
      '80', // a lone continuation byte
      'c0af', // overlong
      'c3', // cut short
      'e282', // cut short
      'eda080', // a surrogate
      'e08080', // overlong three-byte
      'f08f8080', // overlong four-byte
      'f4908080', // above U+10FFFF
      'f5808080', // never a lead byte
      'c328' // a lead byte without its continuation
    ]
    for (const text of bad) {
      expect(() => fromUtf8(fromHex(text)), text).throws(TypeError)
    }
  })

  it('equalBytes compares length and content', () => {
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).equals(true)
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).equals(false)
    expect(equalBytes(Uint8Array.of(1), Uint8Array.of(1, 2))).equals(false)
  })

  it('bucket sizes: frozen vectors', () => {
    const table: Array<[number, number]> = [
      [0, 541],
      [1, 541],
      [539, 542],
      [540, 542],
      [541, 569],
      [542, 569],
      [560, 569],
      [1000, 1021],
      [8000, 8319],
      [65536, 67790],
      [20 * 1024 * 1024, 21453467]
    ]
    for (const [length, size] of table) {
      expect(bucketSize(length), String(length)).equals(size)
    }
  })

  it('bucket sizes follow max(541, ceil(1.05^ceil(log_1.05(n + 1))))', () => {
    for (let n = 0; n < 200000; n += n < 2000 ? 1 : 997) {
      const k = Math.ceil(Math.log(n + 1) / Math.log(1.05))
      const expected = Math.max(SMALLEST_BUCKET, Math.ceil(1.05 ** k))
      expect(bucketSize(n), String(n)).equals(expected)
      expect(bucketSize(n)).greaterThan(n)
    }
    expect(() => bucketSize(-1)).throws(RangeError)
    expect(() => bucketSize(0.5)).throws(RangeError)
  })

  it('padding at the bucket edges', () => {
    // 540 bytes is the most a 542-byte bucket takes; 541 moves to the next.
    expect(pad(new Uint8Array(540)).length).equals(542)
    expect(pad(new Uint8Array(541)).length).equals(569)
    const full = pad(new Uint8Array(540).fill(7))
    expect(full[540]).equals(0x80)
    expect(full[541]).equals(0)
    // Exactly full: the marker is the last byte.
    const exact = pad(new Uint8Array(4).fill(9), 5)
    expect(hex(exact)).equals('0909090980')
    expect(hex(unpad(exact))).equals('09090909')
    expect(() => pad(new Uint8Array(5), 5)).throws(RangeError)
  })

  it('unpad strips the zeros and the marker, and nothing of the content', () => {
    const content = Uint8Array.of(1, 0, 0x80, 0)
    expect(hex(unpad(pad(content)))).equals('01008000')
    expect(unpad(pad(new Uint8Array(0))).length).equals(0)
  })

  it('unpad refuses a buffer with no 0x80', () => {
    expect(() => unpad(new Uint8Array(541))).throws(TypeError, '0x80')
    expect(() => unpad(new Uint8Array(0))).throws(TypeError)
    expect(() => unpad(Uint8Array.of(1, 2, 0, 0))).throws(TypeError)
  })
})
