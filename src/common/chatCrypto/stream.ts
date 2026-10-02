import { bucketSize, equalBytes, pad, unpad } from './bytes'
import { primitives } from './primitives'
import { randomBytes } from './random'

/**
 * Attachments: a STREAM construction over XChaCha20-Poly1305.
 *
 * - A random 32-byte key per attachment, carried inside the message
 *   (`AttachmentRef.key`), never anywhere else.
 * - The file is padded to its bucket (`bytes.ts`) and cut into 64 KiB
 *   chunks. Chunk i is sealed with the nonce `prefix ‖ i ‖ last`: a 16-byte
 *   random prefix, a 7-byte big-endian counter and a 1-byte flag that is 1 on
 *   the final chunk only.
 * - The blob is `prefix ‖ sealed chunk 0 ‖ sealed chunk 1 ‖ …`, and its
 *   digest is the SHA-256 of the whole blob.
 *
 * A reordered chunk fails its counter, a truncated blob ends on a chunk not
 * sealed as last, and a blob with its last chunk dropped likewise; none of
 * them open.
 */

export const CHUNK_SIZE = 65536
const TAG = 16
const PREFIX = 16
const SEALED_CHUNK = CHUNK_SIZE + TAG
const EMPTY = new Uint8Array(0)

export interface SealedAttachment {
  key: Uint8Array
  blob: Uint8Array
  /** SHA-256 of `blob`. */
  digest: Uint8Array
  /** The plaintext's length, before padding. */
  size: number
}

/** `prefix ‖ u56(counter) ‖ last`. */
export function chunkNonce(
  prefix: Uint8Array,
  counter: number,
  last: boolean
): Uint8Array {
  if (prefix.length !== PREFIX) throw new TypeError('Prefix is not 16 bytes')
  const nonce = new Uint8Array(24)
  nonce.set(prefix)
  let rest = counter
  for (let i = 22; i >= 16; i--) {
    nonce[i] = rest % 256
    rest = Math.floor(rest / 256)
  }
  nonce[23] = last ? 1 : 0
  return nonce
}

/** How long the blob of `size` plaintext bytes is. */
export function blobLength(size: number): number {
  const padded = bucketSize(size)
  return PREFIX + padded + Math.ceil(padded / CHUNK_SIZE) * TAG
}

/** Pads, seals and digests a whole file. */
export function sealAttachment(
  plaintext: Uint8Array,
  options: { key?: Uint8Array; prefix?: Uint8Array } = {}
): SealedAttachment {
  const key = options.key ?? randomBytes(32)
  const prefix = options.prefix ?? randomBytes(PREFIX)
  const padded = pad(plaintext)
  const chunks = Math.ceil(padded.length / CHUNK_SIZE)
  const blob = new Uint8Array(PREFIX + padded.length + chunks * TAG)
  blob.set(prefix)
  for (let i = 0; i < chunks; i++) {
    const start = i * CHUNK_SIZE
    const end = Math.min(padded.length, start + CHUNK_SIZE)
    const at = PREFIX + i * SEALED_CHUNK
    blob.set(
      primitives.xchacha20Poly1305Seal(
        key,
        chunkNonce(prefix, i, i === chunks - 1),
        EMPTY,
        padded.subarray(start, end)
      ),
      at
    )
  }
  return { key, blob, digest: primitives.sha256(blob), size: plaintext.length }
}

/**
 * The file in a blob, unpadded. With `digest`, the blob must hash to it
 * first. A wrong key, a changed byte, or chunks reordered, truncated or
 * missing throws.
 */
export function openAttachment(
  key: Uint8Array,
  blob: Uint8Array,
  digest?: Uint8Array
): Uint8Array {
  if (digest != null && !equalBytes(primitives.sha256(blob), digest)) {
    throw new Error('Attachment digest does not match')
  }
  const body = blob.length - PREFIX
  const chunks = Math.ceil(body / SEALED_CHUNK)
  if (body <= TAG || body - (chunks - 1) * SEALED_CHUNK <= TAG) {
    throw new Error('Attachment blob is truncated')
  }
  const prefix = blob.subarray(0, PREFIX)
  const padded = new Uint8Array(body - chunks * TAG)
  for (let i = 0; i < chunks; i++) {
    const at = PREFIX + i * SEALED_CHUNK
    const end = Math.min(blob.length, at + SEALED_CHUNK)
    padded.set(
      primitives.xchacha20Poly1305Open(
        key,
        chunkNonce(prefix, i, i === chunks - 1),
        EMPTY,
        blob.subarray(at, end)
      ),
      i * CHUNK_SIZE
    )
  }
  return unpad(padded)
}
