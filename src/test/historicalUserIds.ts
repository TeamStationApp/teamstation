/** Historical identity encoding, retained only for pre-migration fixtures. */
import { asString, type Cleaner } from 'cleaners'
import { base64url } from 'rfc4648'

import { makeId } from '../common/ids'

// The leading 53 bits of a `usr_` plus 16 base64url characters, a JSON number.
// Fifty-three bits is the largest integer JSON and a TypeScript `number` both
// keep exactly, so the value can sit in `matchup.batter.id`.

const USER_ID = /^usr_[A-Za-z0-9_-]{16}$/
const DECIMAL_ID = /^[1-9][0-9]*$/

export function userIdNumber(id: string): number {
  if (!USER_ID.test(id)) {
    throw new Error(`user id is not usr_ plus 16 base64url characters: ${id}`)
  }
  const bytes = base64url.parse(id.slice(4), { loose: true })
  let n = 0n
  for (const byte of bytes) n = (n << 8n) | BigInt(byte)
  return Number(n >> 43n)
}

/** The one rule for a user id: a positive whole number JSON keeps exactly. */
function isUserIdNumber(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0
}

/** A user id as a Gumbo document carries it: a JSON number and nothing else. */
export const asUserIdNumber: Cleaner<number> = raw => {
  if (typeof raw !== 'number' || !isUserIdNumber(raw)) {
    throw new TypeError(`Expected a user id, got ${JSON.stringify(raw)}`)
  }
  return raw
}

/** A decimal user id, or a `usr_` id read back to that number. */
export const asUserId: Cleaner<number> = raw => {
  if (typeof raw === 'number') return asUserIdNumber(raw)
  const text = asString(raw)
  const n = DECIMAL_ID.test(text)
    ? Number(text)
    : USER_ID.test(text)
      ? userIdNumber(text)
      : NaN
  if (!isUserIdNumber(n)) {
    throw new TypeError(`Expected a user id, got ${JSON.stringify(raw)}`)
  }
  return n
}

/**
 * The user an `external_ids` row of entity type `user` points at. Its
 * `entity_id` is text, and a row migration 031 could not convert keeps
 * whatever it held, so it is read through the user id rule rather than
 * `Number`, which would pass `NaN` on to a query.
 */
export function heldUserId(entityId: string): number {
  try {
    return asUserId(entityId)
  } catch {
    throw new Error(
      `external id points at ${JSON.stringify(entityId)}, which is not a user id`
    )
  }
}

/**
 * Draws a user id. `isTaken` is the caller's lookup. When the first number is
 * already in use, one more is drawn and not checked: two collisions in a
 * 53-bit space do not happen, and the insert's primary key refuses one if
 * they did. Minting reads node crypto, so it lives apart from the module the
 * browser bundle imports.
 */
export function mintUserId(isTaken: (userId: number) => boolean): {
  legacyId: string
  userId: number
} {
  const first = makeId('user')
  const firstId = userIdNumber(first)
  if (!isTaken(firstId)) return { legacyId: first, userId: firstId }
  const second = makeId('user')
  return { legacyId: second, userId: userIdNumber(second) }
}
