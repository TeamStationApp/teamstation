import type { Kysely } from 'kysely'

import { asAccountEmail, asAccountName } from '../../common/accountSettings'
import { conflict, unauthorized, unavailable } from '../../common/errors'
import { mintUserId } from '../../common/mintUserId'
import type { Onboarding } from '../../common/onboarding'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { addEmail, findUserByEmail } from './emails'

export interface SettledAccount {
  userId: number
  displayName: string
  createdAccount: boolean
}

/** Called only after proof of email ownership, shared by code/link/client/invite claims. */
export async function settleAccount(
  db: Kysely<Database>,
  rawEmail: string,
  options: {
    displayName?: string | null
    mint?: () => { userId: number; legacyId: string }
  } = {}
): Promise<SettledAccount> {
  const email = asAccountEmail(rawEmail)
  return await db.transaction().execute(async trx => {
    await lockKeys(trx, [`email:${email}`])
    const existing = await findUserByEmail(trx, email)
    if (existing != null) {
      const user = await trx
        .selectFrom('users')
        .select('disabled_at')
        .where('id', '=', existing.id)
        .executeTakeFirstOrThrow()
      if (user.disabled_at != null)
        throw unauthorized('This account cannot sign in')
      await trx
        .updateTable('user_emails')
        .set({ verified_at: new Date() })
        .where('user_id', '=', existing.id)
        .where(eb => eb.fn('lower', ['email']), '=', email)
        .where('verified_at', 'is', null)
        .execute()
      if (!existing.loginEnabled) {
        await trx
          .updateTable('users')
          .set({
            login_enabled: true,
            onboarding_step: 'name',
            onboarding_completed_at: null
          })
          .where('id', '=', existing.id)
          .execute()
      }
      return {
        userId: existing.id,
        displayName: existing.displayName,
        createdAccount: false
      }
    }
    const displayName =
      options.displayName == null || options.displayName.trim() === ''
        ? 'New account'
        : asAccountName(options.displayName)
    for (let attempt = 0; attempt < 16; attempt++) {
      const minted = options.mint?.() ?? mintUserId(() => false)
      const user = await trx
        .insertInto('users')
        .values({
          id: minted.userId,
          legacyId: minted.legacyId,
          display_name: displayName,
          login_enabled: true,
          is_admin: false,
          onboarding_step: 'name',
          onboarding_completed_at: null
        })
        .onConflict(oc => oc.doNothing())
        .returning('id')
        .executeTakeFirst()
      if (user == null) continue
      const attached = await addEmail(trx, minted.userId, email, {
        isPrimary: true,
        source: 'manual',
        verifiedAt: new Date()
      })
      if (attached.heldBy != null)
        throw conflict(
          'This address has an existing identity that must be resolved before signing in'
        )
      return { userId: minted.userId, displayName, createdAccount: true }
    }
    throw unavailable(
      'An account could not be created. Please retry verification.'
    )
  })
}

export async function onboardingFor(
  db: Kysely<Database>,
  userId: number
): Promise<Onboarding> {
  const user = await db
    .selectFrom('users')
    .select(['onboarding_step', 'onboarding_completed_at'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow()
  return {
    step: user.onboarding_step,
    completedAt:
      user.onboarding_completed_at == null
        ? null
        : user.onboarding_completed_at.toISOString()
  }
}
