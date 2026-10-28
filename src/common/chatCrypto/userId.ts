import { type UserId, valueOfUserId } from '../userId'
import { u64 } from './bytes'

/**
 * Account identities at the crypto boundary. Legacy positive safe integers
 * retain their eight original bytes. Every other identity is ff followed by
 * all sixteen big-endian bytes. The forms have disjoint leading bytes.
 */
export function identityBytes(id: UserId): Uint8Array {
  let value = valueOfUserId(id)
  if (value < 1n << 53n) return u64(value)
  const out = new Uint8Array(17)
  out[0] = 255
  for (let at = 16; at > 0; at--) {
    out[at] = Number(value & 255n)
    value >>= 8n
  }
  return out
}

/** Only the nullable membership-log actor slot admits eight zero bytes. */
export function actorIdentityBytes(id: UserId | null): Uint8Array {
  return id == null ? new Uint8Array(8) : identityBytes(id)
}

export function compareUserIds(a: UserId, b: UserId): number {
  const av = valueOfUserId(a)
  const bv = valueOfUserId(b)
  return av < bv ? -1 : av > bv ? 1 : 0
}
