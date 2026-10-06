import { call } from './core'
import {
  ChatCryptoError,
  type CoreCall,
  flag,
  num,
  readNumber
} from './coreCall'

/**
 * Attachments: a STREAM construction over XChaCha20-Poly1305, on the chat
 * crypto core.
 *
 * - A random 32-byte key per attachment, carried inside the message
 *   (`AttachmentRef.key`), never anywhere else.
 * - The file is padded to its bucket (`bucketSize` in `seal.ts`) and cut
 *   into 64 KiB chunks. Chunk i is sealed with the nonce `prefix ‖ i ‖
 *   last`: a 16-byte random prefix, a 7-byte big-endian counter and a 1-byte
 *   flag that is 1 on the final chunk only.
 * - The blob is `prefix ‖ sealed chunk 0 ‖ sealed chunk 1 ‖ …`, and its
 *   digest is the SHA-256 of the whole blob.
 *
 * A reordered chunk fails its counter, a truncated blob ends on a chunk not
 * sealed as last, and a blob with its last chunk dropped likewise; none of
 * them open.
 *
 * The core seals, opens and hashes a part of at most `PART_CHUNKS` chunks a
 * call, so no call holds a whole file: the browser's WebAssembly memory,
 * which never shrinks, stays a few MiB however large the attachment.
 */

export const CHUNK_SIZE = 65536
const TAG = 16
const PREFIX = 16
const SEALED_CHUNK = CHUNK_SIZE + TAG
const EMPTY = new Uint8Array(0)

/** Chunks a call: 1 MiB of file. */
export const PART_CHUNKS = 16

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
  return call('chunkNonce', [prefix, num(counter), flag(last)])[0]
}

/** How long the blob of `size` plaintext bytes is. */
export function blobLength(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(`Not a length: ${size}`)
  }
  return readNumber(call('blobLength', [num(size)])[0])
}

/** Pads, seals and digests a whole file. */
export function sealAttachment(
  plaintext: Uint8Array,
  options: { key?: Uint8Array; prefix?: Uint8Array } = {}
): SealedAttachment {
  return sealAttachmentWith(call, plaintext, options)
}

/** `sealAttachment` on a given core: the vectors and the bench call it. */
export function sealAttachmentWith(
  core: CoreCall,
  plaintext: Uint8Array,
  options: { key?: Uint8Array; prefix?: Uint8Array } = {}
): SealedAttachment {
  const key = options.key ?? core('randomBytes', [num(32)])[0]
  const prefix = options.prefix ?? core('randomBytes', [num(PREFIX)])[0]
  if (prefix.length !== PREFIX) throw new ChatCryptoError('malformed')
  const size = plaintext.length
  const blob = new Uint8Array(readNumber(core('blobLength', [num(size)])[0]))
  const chunks = Math.ceil((blob.length - PREFIX) / SEALED_CHUNK)
  blob.set(prefix)
  // The blob's digest so far, which each part carries on.
  let state = EMPTY
  let at = PREFIX
  for (let first = 0; first < chunks; first += PART_CHUNKS) {
    const count = Math.min(PART_CHUNKS, chunks - first)
    const [sealed, next] = core('sealAttachmentPart', [
      key,
      prefix,
      num(size),
      num(first),
      num(count),
      plaintext.subarray(first * CHUNK_SIZE, (first + count) * CHUNK_SIZE),
      state
    ])
    blob.set(sealed, at)
    at += sealed.length
    state = next
  }
  const [digest] = core('sha256Finish', [state])
  return { key, blob, digest, size }
}

/**
 * The file in a blob, unpadded. With `digest`, the blob must hash to it,
 * or nothing is returned. A wrong key, a changed byte, or chunks reordered,
 * truncated or missing throws.
 */
export function openAttachment(
  key: Uint8Array,
  blob: Uint8Array,
  digest?: Uint8Array
): Uint8Array {
  return openAttachmentWith(call, key, blob, digest)
}

/**
 * `openAttachment` on a given core: the vectors and the bench call it.
 *
 * One pass: each part is opened and hashed in the same call, and the digest
 * is checked once the last part is open, before anything is returned. A
 * changed byte fails its chunk first; a blob that is authentic but not the
 * one the message names (another blob under the same key) fails the digest.
 * Whatever fails, what was opened is zeroed.
 */
export function openAttachmentWith(
  core: CoreCall,
  key: Uint8Array,
  blob: Uint8Array,
  digest?: Uint8Array
): Uint8Array {
  if (digest != null && digest.length !== 32) {
    throw new Error('Attachment digest does not match')
  }
  const body = blob.length - PREFIX
  const chunks = Math.ceil(body / SEALED_CHUNK)
  if (body <= TAG || body - (chunks - 1) * SEALED_CHUNK <= TAG) {
    throw new Error('Attachment blob is truncated')
  }
  const partBytes = PART_CHUNKS * SEALED_CHUNK
  const prefix = blob.subarray(0, PREFIX)
  const padded = new Uint8Array(body - chunks * TAG)
  // One past the last non-zero byte of the file, so far.
  let end = 0
  try {
    let state = EMPTY
    for (let first = 0; first < chunks; first += PART_CHUNKS) {
      const from = PREFIX + first * SEALED_CHUNK
      const [opened, partEnd, next] = core('openAttachmentPart', [
        key,
        prefix,
        num(first),
        flag(first + PART_CHUNKS >= chunks),
        blob.subarray(from, from + partBytes),
        state
      ])
      padded.set(opened, first * CHUNK_SIZE)
      const reach = readNumber(partEnd)
      if (reach > 0) end = first * CHUNK_SIZE + reach
      state = next
    }
    if (digest != null) {
      const [actual] = core('sha256Finish', [state])
      if (actual.some((byte, i) => byte !== digest[i])) {
        throw new ChatCryptoError('digestMismatch')
      }
    }
    // `plaintext ‖ 0x80 ‖ zeros`: cut at the marker, which the core found.
    if (end === 0 || padded[end - 1] !== 0x80) {
      throw new ChatCryptoError('noPaddingMarker')
    }
  } catch (error) {
    padded.fill(0)
    throw error
  }
  padded[end - 1] = 0
  return padded.subarray(0, end - 1)
}
