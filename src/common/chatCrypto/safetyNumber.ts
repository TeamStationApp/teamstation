import { join, lp, u64 } from './bytes'
import { primitives } from './primitives'

/**
 * Safety numbers, which two people compare to know nobody is in between.
 *
 * For each of the two: SHA-512 applied 5,200 times, starting from
 * `0x00 ‖ lp(identityKey) ‖ u64(userId)`, and the first 30 bytes of the
 * result read as six 5-digit groups (each 5 bytes as a big-endian number,
 * mod 100,000, zero-padded). The two 30-digit halves are put in user-id order,
 * so both people see the same 60 digits.
 */

const ITERATIONS = 5200

export interface SafetyParty {
  userId: number
  identityKey: Uint8Array
}

/** One person's 30 digits. */
export function safetyHalf(party: SafetyParty): string {
  let hash = join(Uint8Array.of(0), lp(party.identityKey), u64(party.userId))
  for (let i = 0; i < ITERATIONS; i++) hash = primitives.sha512(hash)
  let digits = ''
  for (let group = 0; group < 6; group++) {
    let value = 0
    for (let i = 0; i < 5; i++) value = value * 256 + hash[group * 5 + i]
    digits += String(value % 100000).padStart(5, '0')
  }
  return digits
}

/** The 60 digits two people share. */
export function safetyNumber(a: SafetyParty, b: SafetyParty): string {
  const [first, second] = a.userId <= b.userId ? [a, b] : [b, a]
  return safetyHalf(first) + safetyHalf(second)
}

/** The 60 digits as 12 groups of five, for reading aloud. */
export function safetyNumberGroups(digits: string): string[] {
  return digits.match(/\d{5}/g) ?? []
}
