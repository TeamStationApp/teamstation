/**
 * The byte encodings every chat construction is built from.
 *
 * - `lp(x)`: a string as its UTF-8 bytes (or raw bytes as they are), prefixed
 *   with their length as a 4-byte big-endian integer.
 * - `u64(n)`: a whole number — a user id, an epoch, a generation, a `seq`,
 *   milliseconds — as 8 bytes big-endian.
 * - `join(...)` (written `‖`) puts them end to end. Every AAD, KDF input
 *   and hash input in `chatCrypto` is such a join, so no two different inputs
 *   can encode to the same bytes.
 *
 * UTF-8 is done here by hand rather than with `TextEncoder`/`TextDecoder`,
 * because Hermes has no `TextDecoder`, and one implementation everywhere is
 * the only way the phone and the server agree byte for byte.
 */

/** A string's UTF-8 bytes. A lone surrogate becomes U+FFFD, as `TextEncoder` does. */
export function utf8(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i++
      } else {
        code = 0xfffd
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd
    }
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }
  return Uint8Array.from(out)
}

/** UTF-8 bytes back to a string. Anything that is not well-formed UTF-8 throws. */
export function fromUtf8(bytes: Uint8Array): string {
  let text = ''
  let i = 0
  const continuation = (at: number): number => {
    const byte = bytes[at]
    if (byte == null || (byte & 0xc0) !== 0x80) {
      throw new TypeError('Not UTF-8')
    }
    return byte & 0x3f
  }
  while (i < bytes.length) {
    const first = bytes[i]
    let code: number
    if (first < 0x80) {
      code = first
      i += 1
    } else if (first >= 0xc2 && first < 0xe0) {
      code = ((first & 0x1f) << 6) | continuation(i + 1)
      i += 2
    } else if (first >= 0xe0 && first < 0xf0) {
      code =
        ((first & 0x0f) << 12) |
        (continuation(i + 1) << 6) |
        continuation(i + 2)
      // Overlong forms and the surrogate range are not UTF-8.
      if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) {
        throw new TypeError('Not UTF-8')
      }
      i += 3
    } else if (first >= 0xf0 && first < 0xf5) {
      code =
        ((first & 0x07) << 18) |
        (continuation(i + 1) << 12) |
        (continuation(i + 2) << 6) |
        continuation(i + 3)
      if (code < 0x10000 || code > 0x10ffff) throw new TypeError('Not UTF-8')
      i += 4
    } else {
      throw new TypeError('Not UTF-8')
    }
    text += String.fromCodePoint(code)
  }
  return text
}

/** Byte arrays end to end, written `‖`. */
export function join(...parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A string's UTF-8 bytes, or raw bytes, after their length as 4 bytes big-endian. */
export function lp(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? utf8(value) : value
  const out = new Uint8Array(4 + bytes.length)
  const length = bytes.length
  out[0] = (length >>> 24) & 0xff
  out[1] = (length >>> 16) & 0xff
  out[2] = (length >>> 8) & 0xff
  out[3] = length & 0xff
  out.set(bytes, 4)
  return out
}

const TWO_32 = 0x100000000

/** A whole number from 0 to 2^53 − 1 (or a bigint below 2^64) as 8 bytes big-endian. */
export function u64(value: number | bigint): Uint8Array {
  let high: number
  let low: number
  if (typeof value === 'bigint') {
    if (value < 0n || value >= 1n << 64n) {
      throw new RangeError(`Not an unsigned 64-bit integer: ${value}`)
    }
    high = Number(value >> 32n)
    low = Number(value & 0xffffffffn)
  } else {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Not a whole number from 0: ${value}`)
    }
    high = Math.floor(value / TWO_32)
    low = value % TWO_32
  }
  const out = new Uint8Array(8)
  for (let i = 0; i < 4; i++) {
    out[3 - i] = (high >>> (8 * i)) & 0xff
    out[7 - i] = (low >>> (8 * i)) & 0xff
  }
  return out
}

/** Equal length and equal bytes, in time that does not depend on where they differ. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * 1.05^k for k = 0, 1, 2, …, rounded down and up, built on demand.
 *
 * Exact, from 21^k / 20^k in bigints, rather than `Math.pow` and `Math.log`,
 * whose last bit is allowed to differ between engines: a bucket edge computed
 * one way on a phone and another in Node would be two answers to one size.
 */
const floors: number[] = []
const ceilings: number[] = []
let numerator = 1n
let denominator = 1n

function grow(k: number): void {
  while (floors.length <= k) {
    if (floors.length > 0) {
      numerator *= 21n
      denominator *= 20n
    }
    floors.push(Number(numerator / denominator))
    ceilings.push(Number((numerator + denominator - 1n) / denominator))
  }
}

/** The smallest padded size, whatever the content. */
export const SMALLEST_BUCKET = 541

/**
 * The padded size of `length` bytes of plaintext:
 * `max(541, ceil(1.05^ceil(log_1.05(length + 1))))`.
 *
 * The `+ 1` is the `0x80` that marks where the padding starts.
 */
export function bucketSize(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Not a length: ${length}`)
  }
  // ceil(log_1.05(m)) is the least k with 1.05^k ≥ m, and for a whole m that
  // is exactly floor(1.05^k) ≥ m.
  let k = 0
  grow(k)
  while (floors[k] < length + 1) grow(++k)
  return Math.max(SMALLEST_BUCKET, ceilings[k])
}

/** `plaintext`, then `0x80`, then zeros up to `size`. */
export function pad(
  plaintext: Uint8Array,
  size = bucketSize(plaintext.length)
): Uint8Array {
  if (size < plaintext.length + 1) {
    throw new RangeError(`${plaintext.length} bytes do not fit in ${size}`)
  }
  const out = new Uint8Array(size)
  out.set(plaintext)
  out[plaintext.length] = 0x80
  return out
}

/** The plaintext of a padded buffer: trailing zeros and the `0x80` before them go. */
export function unpad(padded: Uint8Array): Uint8Array {
  let end = padded.length - 1
  while (end >= 0 && padded[end] === 0) end--
  if (end < 0 || padded[end] !== 0x80) {
    throw new TypeError('Padding has no 0x80 marker')
  }
  return padded.subarray(0, end)
}
