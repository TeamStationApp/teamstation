import { asString, type Cleaner } from 'cleaners'
import { base64url } from 'rfc4648'

/**
 * Bytes on the chat API: keys, boxes, signatures and nonces travel as
 * base64url (no padding is needed; padding is accepted).
 */

/** A base64url string of `min` to `max` bytes, read back to the bytes. */
export function asBase64urlBytes(min: number, max = min): Cleaner<Uint8Array> {
  return raw => {
    const text = asString(raw)
    let bytes: Uint8Array
    try {
      bytes = base64url.parse(text, { loose: true })
    } catch {
      throw new TypeError('Expected base64url')
    }
    if (bytes.length < min || bytes.length > max) {
      throw new TypeError(
        min === max
          ? `Expected ${min} bytes`
          : `Expected ${min} to ${max} bytes`
      )
    }
    return bytes
  }
}

/** Bytes as the chat API sends them. */
export function b64(bytes: Uint8Array): string {
  return base64url.stringify(new Uint8Array(bytes), { pad: false })
}
