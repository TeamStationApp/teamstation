import { join, lp } from './bytes'
import { primitives } from './primitives'

/**
 * The six digits both screens show while a new device is linked: the first 8
 * bytes of `SHA-256(lp(newDevicePublicKey) ‖ lp(linkId))`, read as an
 * unsigned 64-bit big-endian integer, mod 10^6, zero-padded. Matching digits
 * mean the old device is about to box keys to the device in the person's
 * hand.
 */
export function linkCode(
  newDevicePublicKey: Uint8Array,
  linkId: string
): string {
  const hash = primitives.sha256(join(lp(newDevicePublicKey), lp(linkId)))
  let value = 0n
  for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(hash[i])
  return String(value % 1000000n).padStart(6, '0')
}
