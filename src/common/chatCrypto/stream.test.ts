import { sha256 } from '@noble/hashes/sha2.js'
import { expect } from 'chai'
import { describe, it } from 'mocha'

import { bucketSize, utf8 } from './bytes'
import {
  blobLength,
  CHUNK_SIZE,
  chunkNonce,
  openAttachment,
  sealAttachment
} from './stream'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const seed = (label: string): Uint8Array => sha256(utf8(label))

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
    expect(hex(sealed.digest)).equals(hex(sha256(sealed.blob)))
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
    expect(hex(sealed.digest)).equals(
      '76c6ce34c7b1aebd2f530f7d441de4d6243807a12866fe649abcec55ff0a3c08'
    )
    expect(hex(openAttachment(key, sealed.blob, sealed.digest))).equals(
      hex(file)
    )
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

    it('a digest that does not match fails before anything is opened', () => {
      const digest = sealed.digest.slice()
      digest[0] ^= 1
      expect(() => openAttachment(key, sealed.blob, digest)).throws('digest')
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
