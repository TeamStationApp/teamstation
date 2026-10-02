/**
 * Random bytes, from the one source every platform has.
 *
 * `globalThis.crypto.getRandomValues` is the browser's, Node's, and — through
 * `react-native-get-random-values`, imported first in the root `index.js` —
 * Hermes'. Nothing here falls back to `Math.random`: a phone without the
 * polyfill throws rather than making keys anybody could guess.
 */

interface RandomSource {
  getRandomValues: (array: Uint8Array) => Uint8Array
}

/** The Web Crypto limit on one call. */
const MOST_PER_CALL = 65536

export function randomBytes(length: number): Uint8Array {
  const source = (globalThis as { crypto?: Partial<RandomSource> }).crypto
  if (source?.getRandomValues == null) {
    throw new Error(
      'No crypto.getRandomValues: import react-native-get-random-values first'
    )
  }
  const out = new Uint8Array(length)
  for (let at = 0; at < length; at += MOST_PER_CALL) {
    source.getRandomValues(
      out.subarray(at, Math.min(length, at + MOST_PER_CALL))
    )
  }
  return out
}
