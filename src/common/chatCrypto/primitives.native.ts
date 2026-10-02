import { hchacha } from '@noble/ciphers/chacha.js'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  Ed
} from 'react-native-quick-crypto'

import { AEAD_TAG_LENGTH, type Primitives } from './primitiveTypes'

export type { Aead, Primitives } from './primitiveTypes'

/**
 * The phones' primitives: native code through `react-native-quick-crypto`
 * (OpenSSL over JSI), because Hermes has no JIT and runs the pure-JS ciphers
 * of `primitives.ts` about 145 times slower (0.9 MB/s).
 *
 * - SHA-256, SHA-512 and HMAC-SHA256 are OpenSSL's; HKDF (RFC 5869) is built
 *   here on that HMAC.
 * - ChaCha20-Poly1305 is OpenSSL's IETF construction, with binary AAD.
 * - XChaCha20-Poly1305 is built exactly as libsodium defines it: the subkey is
 *   HChaCha20(key, nonce[0..16]) from `@noble/ciphers`' `hchacha` (one ChaCha
 *   block, negligible in JavaScript), then the native ChaCha20-Poly1305 with
 *   the nonce `0x00000000 ‖ nonce[16..24]`.
 * - X25519 and Ed25519 run on raw keys. Ed25519 verifies strictly, as
 *   `primitives.ts` does with `zip215: false`.
 *
 * Every construction's frozen vector (`vectors.ts`) comes out the same on this
 * twin as on `primitives.ts`; the bench screen checks that on the phone.
 */

const TAG = AEAD_TAG_LENGTH
const SIGMA = Uint32Array.of(0x61707865, 0x3320646e, 0x79622d32, 0x6b206574)
const BASE_POINT = Uint8Array.of(9, ...new Array<number>(31).fill(0))
// Made on first use, not on import: the app imports this module on every
// launch, and a native object nobody asks for should cost nothing.
let x25519Instance: Ed | undefined
let ed25519Instance: Ed | undefined
const x25519Native = (): Ed => (x25519Instance ??= new Ed('x25519', {}))
const ed25519Native = (): Ed => (ed25519Instance ??= new Ed('ed25519', {}))

/**
 * What `setAAD` and `setAuthTag` are typed to take. They accept any byte view
 * (each copies through `binaryLikeToArrayBuffer`), so bytes pass as they are.
 */
type NodeBuffer = Parameters<ReturnType<typeof createCipheriv>['setAAD']>[0]
const asBuffer = (view: Uint8Array): NodeBuffer => view as unknown as NodeBuffer

/** Native results (an ArrayBuffer or a Buffer) as a plain Uint8Array. */
function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function hash(algorithm: 'sha256' | 'sha512', data: Uint8Array): Uint8Array {
  return bytes(createHash(algorithm).update(data).digest())
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return bytes(createHmac('sha256', key).update(data).digest())
}

function chachaSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  data: Uint8Array
): Uint8Array {
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, {
    authTagLength: TAG
  })
  cipher.setAAD(asBuffer(aad))
  const head = bytes(cipher.update(data))
  const tail = bytes(cipher.final())
  const tag = bytes(cipher.getAuthTag())
  const out = new Uint8Array(head.length + tail.length + TAG)
  out.set(head)
  out.set(tail, head.length)
  out.set(tag, head.length + tail.length)
  return out
}

function chachaOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array
): Uint8Array {
  if (sealed.length < TAG) throw new Error('Ciphertext is shorter than a tag')
  const decipher = createDecipheriv('chacha20-poly1305', key, nonce, {
    authTagLength: TAG
  })
  decipher.setAAD(asBuffer(aad))
  decipher.setAuthTag(asBuffer(sealed.subarray(sealed.length - TAG)))
  const head = bytes(decipher.update(sealed.subarray(0, sealed.length - TAG)))
  return concat(head, bytes(decipher.final()))
}

/** Little-endian words, whatever the host's byte order. */
function words(input: Uint8Array): Uint32Array {
  const out = new Uint32Array(input.length / 4)
  for (let i = 0; i < out.length; i++) {
    out[i] =
      (input[4 * i] |
        (input[4 * i + 1] << 8) |
        (input[4 * i + 2] << 16) |
        (input[4 * i + 3] << 24)) >>>
      0
  }
  return out
}

/** XChaCha20's subkey and IETF nonce, from a 32-byte key and a 24-byte nonce. */
function extend(
  key: Uint8Array,
  nonce: Uint8Array
): { subkey: Uint8Array; nonce: Uint8Array } {
  if (key.length !== 32) throw new Error('XChaCha20 key is not 32 bytes')
  if (nonce.length !== 24) throw new Error('XChaCha20 nonce is not 24 bytes')
  const out = new Uint32Array(8)
  hchacha(SIGMA, words(key), words(nonce.subarray(0, 16)), out)
  const subkey = new Uint8Array(32)
  for (let i = 0; i < 8; i++) {
    subkey[4 * i] = out[i] & 0xff
    subkey[4 * i + 1] = (out[i] >>> 8) & 0xff
    subkey[4 * i + 2] = (out[i] >>> 16) & 0xff
    subkey[4 * i + 3] = (out[i] >>> 24) & 0xff
  }
  const ietf = new Uint8Array(12)
  ietf.set(nonce.subarray(16), 4)
  return { subkey, nonce: ietf }
}

function x25519(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = bytes(x25519Native().getSharedSecret(secretKey, publicKey))
  if (shared.every(byte => byte === 0)) {
    throw new Error('X25519 result is all zero')
  }
  return shared
}

export const primitives: Primitives = {
  sha256: data => hash('sha256', data),
  sha512: data => hash('sha512', data),
  hmacSha256,
  hkdfExtract: (salt, ikm) =>
    hmacSha256(salt.length === 0 ? new Uint8Array(32) : salt, ikm),
  hkdfExpand: (prk, info, length) => {
    if (length > 255 * 32) throw new Error('HKDF output is too long')
    const out = new Uint8Array(length)
    let block = new Uint8Array(0)
    for (let i = 0, at = 0; at < length; i++) {
      block = hmacSha256(prk, concat(concat(block, info), Uint8Array.of(i + 1)))
      out.set(block.subarray(0, Math.min(32, length - at)), at)
      at += 32
    }
    return out
  },
  x25519PublicKey: secretKey => x25519(secretKey, BASE_POINT),
  x25519,
  ed25519PublicKey: seed =>
    bytes(
      createPublicKey(
        createPrivateKey({
          key: seed,
          format: 'raw-private',
          asymmetricKeyType: 'ed25519'
        })
      ).export({ format: 'raw-public' })
    ),
  ed25519Sign: (message, seed) =>
    bytes(ed25519Native().signSync(message, seed)),
  ed25519Verify: (signature, message, publicKey) => {
    try {
      return (
        signature.length === 64 &&
        ed25519Native().verifySync(signature, message, publicKey)
      )
    } catch {
      return false
    }
  },
  chacha20Poly1305Seal: chachaSeal,
  chacha20Poly1305Open: chachaOpen,
  xchacha20Poly1305Seal: (key, nonce, aad, data) => {
    const extended = extend(key, nonce)
    return chachaSeal(extended.subkey, extended.nonce, aad, data)
  },
  xchacha20Poly1305Open: (key, nonce, aad, sealed) => {
    const extended = extend(key, nonce)
    return chachaOpen(extended.subkey, extended.nonce, aad, sealed)
  }
}
