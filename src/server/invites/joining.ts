import type { Kysely } from 'kysely'

import { settleAccount } from '../auth/settleAccount'
import type { Database } from '../db/database'
import { findInviteById, inviteProblem, redeemInvite } from './invites'

/**
 * Finishing a sign-in that arrived with an invite on it.
 *
 * This is the half of an invite PeerTube had and TeamStation did not: a
 * stranger holding a link has no account to redeem into, and the server will
 * not make one for an address nobody has proved they can read. So the invite
 * travels on the sign-in request, and the account is made **here** — after the
 * code has been typed or the link opened, which is the moment the address is
 * known to be theirs.
 *
 * Every door leads here: the code typed on the join screen, the link opened on
 * a laptop, and the phone that was left waiting while somebody used the
 * laptop. One of them is used and the other two are already dead, so the
 * account is made once.
 */

export interface SettledJoin {
  userId: number
  displayName: string
  /** True when this sign-in is where the account came from. */
  createdAccount: boolean
  /** False when they already had the access; the sign-in still stands. */
  granted: boolean
}

/**
 * Makes the account if there is none, then redeems the invite for it.
 *
 * An address that already has an account simply gets the access: an invite
 * forwarded to a coach who is already on the team signs them in and changes
 * nothing, which is what they would expect.
 */
export async function settleInviteSignIn(
  db: Kysely<Database>,
  options: { email: string; inviteId: string; displayName?: string | null }
): Promise<SettledJoin | undefined> {
  const knownInvite = await findInviteById(db, options.inviteId)
  if (knownInvite == null) return undefined
  if (knownInvite.guardianOfUserId != null && (knownInvite.forEmail ?? '').trim().toLowerCase() !== options.email.trim().toLowerCase()) return undefined
  const settled = await settleAccount(db, options.email, {
    displayName: options.displayName
  })
  const { userId, displayName, createdAccount } = settled
  const invite = await findInviteById(db, options.inviteId)
  if (invite == null || inviteProblem(invite) != null)
    return { ...settled, granted: false }
  const redemption = await redeemInvite(db, invite, userId, { createdAccount })
  return {
    userId,
    displayName,
    createdAccount,
    granted: redemption.granted
  }
}
