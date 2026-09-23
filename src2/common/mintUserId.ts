import { makeId } from './ids'
import { userIdNumber } from './userIdNumber'

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
