import { fromUtf8, utf8 } from './bytes'
import { call } from './core'

/**
 * The six digits both screens show while a new device is linked: the first 8
 * bytes of `SHA-256(lp(newDevicePublicKey) ‖ lp(linkId))`, read as an
 * unsigned 64-bit big-endian integer, mod 10^6, zero-padded, computed by the
 * chat crypto core. Matching digits mean the old device is about to box keys
 * to the device in the person's hand.
 */
export function linkCode(
  newDevicePublicKey: Uint8Array,
  linkId: string
): string {
  return fromUtf8(call('linkCode', [newDevicePublicKey, utf8(linkId)])[0])
}
