import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import { addEmail, findUserByEmail } from '../auth/emails'
import type { Database } from '../db/database'
import { findInviteById, redeemInvite } from './invites'

/**
 * Finishing a sign-in that arrived with an invite on it.
 *
 * This is the half of an invite PeerTube had and GameStation did not: a
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
  userId: string
  displayName: string
  /** True when this sign-in is where the account came from. */
  createdAccount: boolean
  /** False when they already had the access; the sign-in still stands. */
  granted: boolean
}

/**
 * A name for somebody who did not give one.
 *
 * The local part of the address, which is wrong often enough to be worth
 * changing later and right often enough to beat showing an e-mail address to
 * the whole team. Never blank: the column is not null, and a nameless row is
 * one every screen has to guess at.
 */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? ''
  const cleaned = local.replace(/[._-]+/g, ' ').trim()
  return cleaned === '' ? 'Somebody' : cleaned
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
  const invite = await findInviteById(db, options.inviteId)
  if (invite == null) return undefined

  const email = options.email.trim().toLowerCase()
  const existing = await findUserByEmail(db, email)

  let userId = existing?.id
  let displayName = existing?.displayName ?? ''
  let createdAccount = false

  if (userId == null) {
    const wanted = (options.displayName ?? '').trim()
    displayName = wanted === '' ? nameFromEmail(email) : wanted
    userId = makeId('user')
    createdAccount = true
    await db.transaction().execute(async trx => {
      await trx
        .insertInto('users')
        .values({
          id: userId as string,
          display_name: displayName,
          // By e-mail code, like everybody who arrived from PeerTube without
          // a password. A password can be set later; nothing here needs one.
          login_enabled: true,
          is_admin: false
        })
        .execute()
      await addEmail(trx, userId as string, email, {
        isPrimary: true,
        source: 'manual',
        // Verified by the very code or link that got us here.
        verifiedAt: new Date()
      })
    })
  }

  const redemption = await redeemInvite(db, invite, userId, { createdAccount })
  return {
    userId,
    displayName,
    createdAccount,
    granted: redemption.granted
  }
}
