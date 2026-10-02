/**
 * The shape both `primitives` twins share. Its own file, because Metro
 * resolves `./primitives` inside `primitives.native.ts` back to itself.
 */
export interface Primitives {
  sha256: (data: Uint8Array) => Uint8Array
  sha512: (data: Uint8Array) => Uint8Array
  hmacSha256: (key: Uint8Array, data: Uint8Array) => Uint8Array
  /** HKDF-SHA256 extract; an empty salt is 32 zero bytes. */
  hkdfExtract: (salt: Uint8Array, ikm: Uint8Array) => Uint8Array
  hkdfExpand: (prk: Uint8Array, info: Uint8Array, length: number) => Uint8Array
  /** X25519 public key of a secret. */
  x25519PublicKey: (secretKey: Uint8Array) => Uint8Array
  /** X25519; throws on an all-zero result (a small-order public key). */
  x25519: (secretKey: Uint8Array, publicKey: Uint8Array) => Uint8Array
  /** Ed25519 public key of a 32-byte seed. */
  ed25519PublicKey: (seed: Uint8Array) => Uint8Array
  ed25519Sign: (message: Uint8Array, seed: Uint8Array) => Uint8Array
  /** False for a bad or malformed signature or key; never throws. */
  ed25519Verify: (
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array
  ) => boolean
  /** ChaCha20-Poly1305 (RFC 8439), 12-byte nonce. */
  chacha20Poly1305Seal: Aead
  chacha20Poly1305Open: Aead
  /** XChaCha20-Poly1305, 24-byte nonce. */
  xchacha20Poly1305Seal: Aead
  xchacha20Poly1305Open: Aead
}

export type Aead = (
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  data: Uint8Array
) => Uint8Array

/** The Poly1305 tag both AEADs append, in bytes. */
export const AEAD_TAG_LENGTH = 16
