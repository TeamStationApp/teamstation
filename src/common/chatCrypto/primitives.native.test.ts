import Module from 'node:module'

import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { primitives } from './primitives'
import type { Primitives } from './primitiveTypes'
import { runVectors, toHex } from './vectors'

/**
 * U3: the phones' twin, `primitives.native.ts`, wired to a stand-in for
 * `react-native-quick-crypto` built on `@noble`.
 *
 * The stand-in has the same shape as the parts of quick-crypto the twin
 * calls — `createHash`, `createHmac`, `createCipheriv`/`createDecipheriv` for
 * `chacha20-poly1305` (update, final, AAD and tag), `createPrivateKey` /
 * `createPublicKey` on a raw seed, and `Ed` for raw-key X25519 and Ed25519 —
 * so what is tested here is the twin's own code: its HKDF, its XChaCha20 built
 * from HChaCha20 and the IETF cipher, its byte handling, and that every
 * construction's frozen vector comes out the same through it. The phone run
 * of the bench screen checks the same vectors against the real library.
 */

type Bytes = Uint8Array

function collector(): { push: (data: Bytes) => void; all: () => Bytes } {
  const parts: Bytes[] = []
  return {
    push: data => {
      parts.push(Uint8Array.from(data))
    },
    all: () => {
      const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
      let at = 0
      for (const part of parts) {
        out.set(part, at)
        at += part.length
      }
      return out
    }
  }
}

/** Only what the twin uses, behaving as quick-crypto does. */
const fakeQuickCrypto = {
  createHash: (algorithm: string) => {
    const input = collector()
    const hasher = algorithm === 'sha512' ? sha512 : sha256
    const self = {
      update: (data: Bytes) => {
        input.push(data)
        return self
      },
      digest: () => Buffer.from(hasher(input.all()))
    }
    return self
  },
  createHmac: (algorithm: string, key: Bytes) => {
    expect(algorithm).equals('sha256')
    const input = collector()
    const self = {
      update: (data: Bytes) => {
        input.push(data)
        return self
      },
      digest: () => Buffer.from(hmac(sha256, key, input.all()))
    }
    return self
  },
  createCipheriv: (
    algorithm: string,
    key: Bytes,
    nonce: Bytes,
    options: { authTagLength: number }
  ) => {
    expect(algorithm).equals('chacha20-poly1305')
    expect(options.authTagLength).equals(16)
    let aad = new Uint8Array(0)
    const input = collector()
    let tag = new Uint8Array(0)
    return {
      setAAD: (data: Bytes) => {
        aad = Uint8Array.from(data)
      },
      // OpenSSL hands back ciphertext as it goes; here it all comes at the
      // end, which the twin must cope with as well.
      update: (data: Bytes) => {
        input.push(data)
        return Buffer.alloc(0)
      },
      final: () => {
        const sealed = chacha20poly1305(key, nonce, aad).encrypt(input.all())
        tag = sealed.slice(sealed.length - 16)
        return Buffer.from(sealed.subarray(0, sealed.length - 16))
      },
      getAuthTag: () => Buffer.from(tag)
    }
  },
  createDecipheriv: (
    algorithm: string,
    key: Bytes,
    nonce: Bytes,
    options: { authTagLength: number }
  ) => {
    expect(algorithm).equals('chacha20-poly1305')
    expect(options.authTagLength).equals(16)
    let aad = new Uint8Array(0)
    let tag = new Uint8Array(0)
    const input = collector()
    return {
      setAAD: (data: Bytes) => {
        aad = Uint8Array.from(data)
      },
      setAuthTag: (data: Bytes) => {
        tag = Uint8Array.from(data)
      },
      update: (data: Bytes) => {
        input.push(data)
        return Buffer.alloc(0)
      },
      final: () => {
        const body = input.all()
        const sealed = new Uint8Array(body.length + tag.length)
        sealed.set(body)
        sealed.set(tag, body.length)
        return Buffer.from(chacha20poly1305(key, nonce, aad).decrypt(sealed))
      }
    }
  },
  createPrivateKey: (input: {
    key: Bytes
    format: string
    asymmetricKeyType: string
  }) => {
    expect(input.format).equals('raw-private')
    expect(input.asymmetricKeyType).equals('ed25519')
    return { seed: Uint8Array.from(input.key) }
  },
  createPublicKey: (privateKey: { seed: Bytes }) => ({
    export: (options: { format: string }) => {
      expect(options.format).equals('raw-public')
      return Buffer.from(ed25519.getPublicKey(privateKey.seed))
    }
  }),
  /** Raw-key X25519 and Ed25519, answering ArrayBuffers as the native class does. */
  Ed: class {
    constructor(readonly type: string) {}
    getSharedSecret(secretKey: Bytes, publicKey: Bytes): ArrayBuffer {
      expect(this.type).equals('x25519')
      return x25519.getSharedSecret(secretKey, publicKey).slice().buffer
    }

    signSync(message: Bytes, seed: Bytes): ArrayBuffer {
      expect(this.type).equals('ed25519')
      return ed25519.sign(message, seed).slice().buffer
    }

    verifySync(signature: Bytes, message: Bytes, publicKey: Bytes): boolean {
      return ed25519.verify(signature, message, publicKey, { zip215: false })
    }
  }
}

const quickCryptoPath = require.resolve('react-native-quick-crypto')
let native: Primitives
const saved = { ...primitives }

before(() => {
  const stand = new Module(quickCryptoPath)
  stand.exports = fakeQuickCrypto
  stand.loaded = true
  require.cache[quickCryptoPath] = stand

  native = (require('./primitives.native') as { primitives: Primitives })
    .primitives
})

after(() => {
  Object.assign(primitives, saved)
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete require.cache[quickCryptoPath]
})

const bytesOf = (length: number, start = 1): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (start + i * 7) & 0xff)

describe('chatCrypto primitives.native (on a stand-in)', () => {
  it('hashes and HMACs like noble', () => {
    for (const length of [0, 1, 55, 64, 1000]) {
      const data = bytesOf(length)
      expect(toHex(native.sha256(data))).equals(toHex(sha256(data)))
      expect(toHex(native.sha512(data))).equals(toHex(sha512(data)))
      expect(toHex(native.hmacSha256(bytesOf(32, 9), data))).equals(
        toHex(hmac(sha256, bytesOf(32, 9), data))
      )
    }
  })

  it('builds HKDF on the HMAC exactly as noble’s, empty salt included', () => {
    for (const salt of [new Uint8Array(0), bytesOf(13), bytesOf(80)]) {
      expect(toHex(native.hkdfExtract(salt, bytesOf(40)))).equals(
        toHex(saved.hkdfExtract(salt, bytesOf(40)))
      )
    }
    const prk = bytesOf(32, 3)
    for (const length of [0, 1, 32, 33, 64, 100, 255 * 32]) {
      expect(toHex(native.hkdfExpand(prk, bytesOf(10), length))).equals(
        toHex(saved.hkdfExpand(prk, bytesOf(10), length))
      )
    }
    expect(() => native.hkdfExpand(prk, bytesOf(10), 255 * 32 + 1)).throws(
      'too long'
    )
  })

  it('X25519 and Ed25519 on raw keys, like noble', () => {
    const a = bytesOf(32, 5)
    const b = bytesOf(32, 11)
    expect(toHex(native.x25519PublicKey(a))).equals(
      toHex(x25519.getPublicKey(a))
    )
    expect(toHex(native.x25519(a, saved.x25519PublicKey(b)))).equals(
      toHex(saved.x25519(a, saved.x25519PublicKey(b)))
    )
    expect(() => native.x25519(a, new Uint8Array(32))).throws()
    expect(toHex(native.ed25519PublicKey(a))).equals(
      toHex(ed25519.getPublicKey(a))
    )
    const signature = native.ed25519Sign(bytesOf(100), a)
    expect(toHex(signature)).equals(toHex(ed25519.sign(bytesOf(100), a)))
    const publicKey = native.ed25519PublicKey(a)
    expect(native.ed25519Verify(signature, bytesOf(100), publicKey)).equals(
      true
    )
    expect(native.ed25519Verify(signature, bytesOf(99), publicKey)).equals(
      false
    )
    expect(
      native.ed25519Verify(signature.subarray(1), bytesOf(100), publicKey)
    ).equals(false)
    expect(native.ed25519Verify(signature, bytesOf(100), bytesOf(5))).equals(
      false
    )
  })

  it('an all-zero X25519 result throws even where the library returns it', () => {
    const stand = fakeQuickCrypto.Ed.prototype
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const real = stand.getSharedSecret
    stand.getSharedSecret = () => new ArrayBuffer(32)
    try {
      expect(() => native.x25519(bytesOf(32), bytesOf(32))).throws('all zero')
    } finally {
      stand.getSharedSecret = real
    }
  })

  it('ChaCha20-Poly1305 and XChaCha20-Poly1305 match noble, AAD and all', () => {
    const key = bytesOf(32, 21)
    for (const length of [0, 1, 64, 1000]) {
      const data = bytesOf(length, 2)
      const aad = bytesOf(length % 37, 200)
      const sealed = native.chacha20Poly1305Seal(key, bytesOf(12), aad, data)
      expect(toHex(sealed)).equals(
        toHex(chacha20poly1305(key, bytesOf(12), aad).encrypt(data))
      )
      expect(
        toHex(native.chacha20Poly1305Open(key, bytesOf(12), aad, sealed))
      ).equals(toHex(data))
      const xsealed = native.xchacha20Poly1305Seal(key, bytesOf(24), aad, data)
      expect(toHex(xsealed)).equals(
        toHex(xchacha20poly1305(key, bytesOf(24), aad).encrypt(data))
      )
      expect(
        toHex(native.xchacha20Poly1305Open(key, bytesOf(24), aad, xsealed))
      ).equals(toHex(data))
    }
  })

  it('refuses a changed byte, a wrong AAD, a short ciphertext and bad sizes', () => {
    const key = bytesOf(32, 21)
    const sealed = native.xchacha20Poly1305Seal(
      key,
      bytesOf(24),
      bytesOf(3),
      bytesOf(50)
    )
    const changed = sealed.slice()
    changed[10] ^= 1
    expect(() =>
      native.xchacha20Poly1305Open(key, bytesOf(24), bytesOf(3), changed)
    ).throws()
    expect(() =>
      native.xchacha20Poly1305Open(key, bytesOf(24), bytesOf(4), sealed)
    ).throws()
    // An empty message is still authenticated: the tag alone is checked.
    const empty = native.xchacha20Poly1305Seal(
      key,
      bytesOf(24),
      bytesOf(3),
      new Uint8Array(0)
    )
    const forged = empty.slice()
    forged[0] ^= 1
    expect(() =>
      native.xchacha20Poly1305Open(key, bytesOf(24), bytesOf(3), forged)
    ).throws()
    expect(() =>
      native.chacha20Poly1305Open(key, bytesOf(12), bytesOf(3), bytesOf(15))
    ).throws('shorter than a tag')
    expect(() =>
      native.xchacha20Poly1305Seal(
        bytesOf(31),
        bytesOf(24),
        bytesOf(0),
        bytesOf(1)
      )
    ).throws('32 bytes')
    expect(() =>
      native.xchacha20Poly1305Seal(key, bytesOf(12), bytesOf(0), bytesOf(1))
    ).throws('24 bytes')
  })

  it('reproduces every frozen vector through the constructions', () => {
    Object.assign(primitives, native)
    try {
      const results = runVectors()
      expect(results.filter(result => !result.ok)).deep.equals([])
      expect(results.length).greaterThan(30)
    } finally {
      Object.assign(primitives, saved)
    }
  })
})
