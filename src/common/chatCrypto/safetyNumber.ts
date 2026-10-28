import type { UserId } from '../userId'
import { fromUtf8 } from './bytes'
import { call } from './core'
import { compareUserIds, identityBytes } from './userId'

/**
 * Safety numbers, which two people compare to know nobody is in between.
 *
 * For each of the two: SHA-512 applied 5,200 times, starting from
 * `0x00 ‖ lp(identityKey) ‖ identity(userId)`, and the first 30 bytes of the
 * result read as six 5-digit groups (each 5 bytes as a big-endian number,
 * mod 100,000, zero-padded), computed by the chat crypto core. The two
 * 30-digit halves are put in user-id order, so both people see the same 60
 * digits.
 */

export interface SafetyParty {
  userId: UserId
  identityKey: Uint8Array
}

/** One person's 30 digits. */
export function safetyHalf(party: SafetyParty): string {
  return fromUtf8(
    call('safetyHalf', [party.identityKey, identityBytes(party.userId)])[0]
  )
}

/** The 60 digits two people share. */
export function safetyNumber(a: SafetyParty, b: SafetyParty): string {
  const [first, second] =
    compareUserIds(a.userId, b.userId) <= 0 ? [a, b] : [b, a]
  return safetyHalf(first) + safetyHalf(second)
}

/** The 60 digits as 12 groups of five, for reading aloud. */
export function safetyNumberGroups(digits: string): string[] {
  return digits.match(/\d{5}/g) ?? []
}
