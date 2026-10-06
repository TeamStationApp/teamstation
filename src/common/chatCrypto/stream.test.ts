import { expect } from 'chai'
import { describe, it } from 'mocha'

import { hex, oracle, seed } from '../../test/chatCryptoOracle'
import { utf8 } from './bytes'
import { call } from './core'
import { type CoreCall, num } from './coreCall'
import { bucketSize } from './seal'
import {
  blobLength,
  CHUNK_SIZE,
  chunkNonce,
  openAttachment,
  openAttachmentWith,
  PART_CHUNKS,
  sealAttachment,
  sealAttachmentWith
} from './stream'

const key = seed('attachment key')
const prefix = seed('prefix').subarray(0, 16)
const SEALED = CHUNK_SIZE + 16

function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = i % 251
  return bytes
}

describe('chatCrypto stream', () => {
  it('the chunk nonce is prefix ‖ 7-byte counter ‖ last flag', () => {
    expect(hex(chunkNonce(prefix, 0x010203, true))).equals(
      hex(prefix) + '00000000010203' + '01'
    )
    expect(hex(chunkNonce(prefix, 2 ** 53 - 1, false))).equals(
      hex(prefix) + '1fffffffffffff' + '00'
    )
    expect(() => chunkNonce(new Uint8Array(15), 0, false)).throws(TypeError)
  })

  it('a small file: frozen vector', () => {
    const sealed = sealAttachment(utf8('hello attachment'), { key, prefix })
    expect(sealed.size).equals(16)
    expect(sealed.blob.length).equals(16 + 541 + 16)
    expect(sealed.blob.length).equals(blobLength(16))
    expect(hex(sealed.blob.subarray(0, 48))).equals(
      'e7a2e8b216e5aec3facf743962d3997fb0712d1f7e72ed2eb903a7ba3fb18fdfdd6c36194a7fe8ea4c521f9c4bfe78a1'
    )
    expect(hex(sealed.digest)).equals(
      '7da7e9fee49f0c99e2e40d7d46d853e2b32dd9303bdb165d9931a871c58cb491'
    )
    expect(hex(sealed.digest)).equals(hex(oracle.sha256(sealed.blob)))
    expect(
      Buffer.from(openAttachment(key, sealed.blob, sealed.digest)).toString()
    ).equals('hello attachment')
  })

  it('a file of several chunks: frozen vector, and it round-trips', () => {
    const file = pattern(200000)
    const sealed = sealAttachment(file, { key, prefix })
    const padded = bucketSize(200000)
    expect(sealed.blob.length).equals(
      16 + padded + Math.ceil(padded / CHUNK_SIZE) * 16
    )
    expect(sealed.blob.length).equals(blobLength(200000))
    expect(() => blobLength(-1)).throws(RangeError)
    expect(() => blobLength(0.5)).throws(RangeError)
    expect(hex(sealed.digest)).equals(
      '76c6ce34c7b1aebd2f530f7d441de4d6243807a12866fe649abcec55ff0a3c08'
    )
    expect(hex(openAttachment(key, sealed.blob, sealed.digest))).equals(
      hex(file)
    )
  })

  it('a file of several parts is the chunks the construction says', () => {
    // 2.5 MiB: three parts, the last with the padding.
    const size = 2.5 * 1024 * 1024
    const file = pattern(size)
    const sealed = sealAttachment(file, { key, prefix })
    const padded = new Uint8Array(bucketSize(size))
    padded.set(file)
    padded[size] = 0x80
    const chunks = Math.ceil(padded.length / CHUNK_SIZE)
    expect(chunks).above(2 * PART_CHUNKS)
    expect(hex(sealed.blob.subarray(0, 16))).equals(hex(prefix))
    for (const i of [0, PART_CHUNKS - 1, PART_CHUNKS, chunks - 1]) {
      const expected = oracle.xchacha20Poly1305Seal(
        key,
        chunkNonce(prefix, i, i === chunks - 1),
        new Uint8Array(0),
        padded.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
      )
      const at = 16 + i * SEALED
      expect(hex(sealed.blob.subarray(at, at + expected.length))).equals(
        hex(expected)
      )
    }
    expect(sealed.blob.length).equals(blobLength(size))
    expect(hex(sealed.digest)).equals(hex(oracle.sha256(sealed.blob)))
    const opened = openAttachment(key, sealed.blob, sealed.digest)
    expect(opened.length).equals(size)
    expect(hex(oracle.sha256(opened))).equals(hex(oracle.sha256(file)))
    // A byte changed in the second part fails, digest or none.
    const changed = sealed.blob.slice()
    changed[16 + (PART_CHUNKS + 1) * SEALED] ^= 1
    expect(() => openAttachment(key, changed)).throws('notAuthentic')
    expect(() => openAttachment(key, changed, sealed.digest)).throws(
      'notAuthentic'
    )
  })

  it('a call holds a part, never the file', () => {
    const sizes: number[] = []
    const watched: CoreCall = (op, args) => {
      sizes.push(args.reduce((sum, arg) => sum + arg.length, 0))
      return call(op, args)
    }
    const file = pattern(2.5 * 1024 * 1024)
    const sealed = sealAttachmentWith(watched, file, { key, prefix })
    openAttachmentWith(watched, key, sealed.blob, sealed.digest)
    expect(Math.max(...sizes)).below(PART_CHUNKS * SEALED + 200)
  })

  it('a blob that opens to no padding marker fails; a short prefix is refused', () => {
    const sealed = sealAttachment(utf8('marker'), { key, prefix })
    const unmarked: CoreCall = (op, args) => {
      if (op !== 'openAttachmentPart') return call(op, args)
      const [real, , state] = call(op, args)
      const opened = new Uint8Array(real.length)
      opened[0] = 1
      return [opened, num(1), state]
    }
    expect(() => openAttachmentWith(unmarked, key, sealed.blob)).throws(
      'noPaddingMarker'
    )
    expect(() =>
      sealAttachment(utf8('x'), { prefix: new Uint8Array(15) })
    ).throws('malformed')
  })

  it('an empty file, and one a byte short of a chunk', () => {
    const sealed = sealAttachment(new Uint8Array(0))
    expect(openAttachment(sealed.key, sealed.blob).length).equals(0)
    const exact = sealAttachment(pattern(CHUNK_SIZE - 1), { key, prefix })
    expect(openAttachment(key, exact.blob).length).equals(CHUNK_SIZE - 1)
  })

  it('a random key and prefix differ every time', () => {
    const one = sealAttachment(utf8('same'))
    const two = sealAttachment(utf8('same'))
    expect(hex(one.key)).not.equals(hex(two.key))
    expect(hex(one.blob.subarray(0, 16))).not.equals(
      hex(two.blob.subarray(0, 16))
    )
    expect(Buffer.from(openAttachment(two.key, two.blob)).toString()).equals(
      'same'
    )
  })

  describe('tampering', () => {
    const file = pattern(3 * CHUNK_SIZE + 1000)
    const sealed = sealAttachment(file, { key, prefix })
    const chunks = Math.ceil((sealed.blob.length - 16) / SEALED)

    it('has the chunks the test needs', () => {
      expect(chunks).equals(4)
    })

    it('a flipped byte fails, anywhere', () => {
      for (const at of [0, 20, 16 + SEALED, sealed.blob.length - 1]) {
        const blob = sealed.blob.slice()
        blob[at] ^= 1
        expect(() => openAttachment(key, blob), String(at)).throws()
      }
    })

    it('a digest that does not match fails, and nothing is returned', () => {
      const digest = sealed.digest.slice()
      digest[0] ^= 1
      expect(() => openAttachment(key, sealed.blob, digest)).throws('digest')
      // An empty digest would be "no digest" to the core: never accepted.
      for (const short of [new Uint8Array(0), sealed.digest.subarray(0, 31)]) {
        expect(() => openAttachment(key, sealed.blob, short)).throws('digest')
      }
    })

    it('the wrong key fails', () => {
      expect(() => openAttachment(seed('other'), sealed.blob)).throws()
    })

    it('two chunks swapped fail', () => {
      const blob = sealed.blob.slice()
      const first = sealed.blob.subarray(16, 16 + SEALED)
      const second = sealed.blob.subarray(16 + SEALED, 16 + 2 * SEALED)
      blob.set(second, 16)
      blob.set(first, 16 + SEALED)
      expect(() => openAttachment(key, blob)).throws()
    })

    it('the last chunk missing fails', () => {
      const blob = sealed.blob.subarray(0, 16 + (chunks - 1) * SEALED)
      expect(() => openAttachment(key, blob)).throws()
    })

    it('a blob truncated inside a chunk fails', () => {
      expect(() =>
        openAttachment(key, sealed.blob.subarray(0, sealed.blob.length - 1))
      ).throws()
      expect(() =>
        openAttachment(key, sealed.blob.subarray(0, 16 + SEALED + 100))
      ).throws()
    })

    it('a blob cut down to its prefix, or to a stub of a chunk, fails', () => {
      expect(() => openAttachment(key, sealed.blob.subarray(0, 16))).throws(
        'truncated'
      )
      expect(() => openAttachment(key, sealed.blob.subarray(0, 30))).throws(
        'truncated'
      )
      expect(() =>
        openAttachment(key, sealed.blob.subarray(0, 16 + SEALED + 10))
      ).throws('truncated')
    })

    it('a chunk dropped from the middle fails', () => {
      const blob = new Uint8Array(sealed.blob.length - SEALED)
      blob.set(sealed.blob.subarray(0, 16 + SEALED))
      blob.set(sealed.blob.subarray(16 + 2 * SEALED), 16 + SEALED)
      expect(() => openAttachment(key, blob)).throws()
    })
  })
})
