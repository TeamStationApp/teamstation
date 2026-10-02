import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { expand, extract } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'

import type { Primitives } from './primitiveTypes'

export type { Aead, Primitives } from './primitiveTypes'

/**
 * The cryptographic primitives every chat construction is built on, and the
 * only place they come from.
 *
 * This file is the web's, the server's and Node's: `@noble`, pure TypeScript,
 * about 130 MB/s in V8. Its twin `primitives.native.ts` is the phones', on
 * native code, because Hermes has no JIT and runs these ciphers about 145
 * times slower. The constructions (`hpke.ts`, `seal.ts`, `stream.ts`, …) call
 * `primitives.<name>` and nothing else, so they are one code path everywhere,
 * and `vectors.ts` proves the two twins give the same bytes.
 *
 * Keys are raw: a 32-byte X25519 secret (clamped by the curve, not here), a
 * 32-byte Ed25519 seed. An AEAD's output is ciphertext ‖ 16-byte tag; opening
 * anything that does not authenticate throws.
 */
const isZero = (bytes: Uint8Array): boolean => bytes.every(byte => byte === 0)

export const primitives: Primitives = {
  sha256: data => sha256(data),
  sha512: data => sha512(data),
  hmacSha256: (key, data) => hmac(sha256, key, data),
  hkdfExtract: (salt, ikm) => extract(sha256, ikm, salt),
  hkdfExpand: (prk, info, length) => expand(sha256, prk, info, length),
  x25519PublicKey: secretKey => x25519.getPublicKey(secretKey),
  x25519: (secretKey, publicKey) => {
    const shared = x25519.getSharedSecret(secretKey, publicKey)
    if (isZero(shared)) throw new Error('X25519 result is all zero')
    return shared
  },
  ed25519PublicKey: seed => ed25519.getPublicKey(seed),
  ed25519Sign: (message, seed) => ed25519.sign(message, seed),
  ed25519Verify: (signature, message, publicKey) => {
    try {
      // zip215 off: RFC 8032's strict rules, which libsodium's verify keeps on
      // the phones, so a signature is valid in both places or in neither.
      return ed25519.verify(signature, message, publicKey, { zip215: false })
    } catch {
      return false
    }
  },
  chacha20Poly1305Seal: (key, nonce, aad, data) =>
    chacha20poly1305(key, nonce, aad).encrypt(data),
  chacha20Poly1305Open: (key, nonce, aad, data) =>
    chacha20poly1305(key, nonce, aad).decrypt(data),
  xchacha20Poly1305Seal: (key, nonce, aad, data) =>
    xchacha20poly1305(key, nonce, aad).encrypt(data),
  xchacha20Poly1305Open: (key, nonce, aad, data) =>
    xchacha20poly1305(key, nonce, aad).decrypt(data)
}
