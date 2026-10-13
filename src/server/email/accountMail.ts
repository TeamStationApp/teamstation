import type { Kysely } from 'kysely'

import { requireNodeAdmin } from '../admin/nodeAdministration'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'

/** The system_settings key a node administrator flips. */
export const accountMailKey = 'mail.accountMessages'

/**
 * Whether invitations and "you were added" notices are mailed.
 *
 * Sign-in codes are not this setting. Anything other than `true` — a missing
 * row included — means off.
 */
export async function accountMailEnabled(
  db: Kysely<Database>
): Promise<boolean> {
  const row = await db
    .selectFrom('system_settings')
    .select('value')
    .where('key', '=', accountMailKey)
    .executeTakeFirst()
  return row?.value === true
}

/** A node administrator turns account mail on or off. */
export async function setAccountMailEnabled(
  db: Kysely<Database>,
  actor: Actor,
  enabled: boolean
): Promise<void> {
  const admin = await requireNodeAdmin(
    db,
    actor,
    'Only a node administrator can change account mail'
  )
  await db
    .insertInto('system_settings')
    .values({
      key: accountMailKey,
      value: enabled,
      updated_by: admin.userId
    })
    .onConflict(oc =>
      oc.column('key').doUpdateSet({
        value: enabled,
        updated_at: new Date(),
        updated_by: admin.userId
      })
    )
    .execute()
}

/**
 * Sends one account message when the setting allows it.
 *
 * When the setting is off the send is skipped. The invitation or the grant
 * has already been saved; this only decides whether mail goes with it.
 */
export async function deliverAccountMail(
  db: Kysely<Database>,
  email: string,
  send: () => Promise<void>,
  logger: Pick<Console, 'log'> = console
): Promise<void> {
  if (!(await accountMailEnabled(db))) {
    logger.log(`account mail is off; not sent to ${email}`)
    return
  }
  await send()
}
