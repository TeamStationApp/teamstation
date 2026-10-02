import { primitives } from './primitives'

/** HKDF-SHA256 in one call, on the platform's primitives: extract, then expand. */
export function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Uint8Array {
  return primitives.hkdfExpand(primitives.hkdfExtract(salt, ikm), info, length)
}
