import type { Kysely } from 'kysely'

import type { Database } from '../../db/database'
import {
  createAccount,
  type FixtureAccount,
  type FixtureManifest,
  makeNonce
} from './accounts'
import { isTestAddress } from './address'
import { NODE_SETTINGS } from './nodeSettings'

/**
 * Settings this fixture changes are only safe where nothing real lives, so it refuses
 * a database holding any address but a test one. An empty database satisfies that;
 * a copy of production cannot. Returns the addresses it read.
 */
export async function refuseRealAddresses(
  db: Kysely<Database>,
  mailbox: string
): Promise<string[]> {
  const rows = await db.selectFrom('user_emails').select('email').execute()
  const emails = rows.map(row => row.email)
  const real = emails.filter(email => !isTestAddress(mailbox, email))
  if (real.length > 0) {
    throw new Error(
      `fixtures refuse this database: ${real.length} address(es) are not test addresses`
    )
  }
  return emails
}

const ROLES = {
  admin: { person: { first: 'Ichiro', last: 'Suzuki' }, isAdmin: true },
  member: { person: { first: 'Ken', last: 'Griffey' }, isAdmin: false }
}

/**
 * The accounts and settings every scenario may assume. A second run changes nothing:
 * it makes no second set of accounts and reports none, because their passwords are
 * gone, so a seat keeps the manifest its first run wrote.
 */
export async function runBaseline(
  db: Kysely<Database>,
  mailbox: string
): Promise<FixtureManifest> {
  // Read once: every address is a test one, and a role whose address is
  // among them already has its account.
  const emails = await refuseRealAddresses(db, mailbox)
  const nonce = makeNonce()
  // One transaction, so a run that fails part way leaves no account whose
  // password nobody was told; the next run makes them all.
  const accounts = await db.transaction().execute(async trx => {
    for (const [key, value] of Object.entries(NODE_SETTINGS)) {
      await trx
        .insertInto('system_settings')
        .values({ key, value: value as never })
        .onConflict(oc =>
          oc.column('key').doUpdateSet({ value: value as never })
        )
        .execute()
    }
    const context = { db: trx, mailbox, nonce }
    const made: Record<string, FixtureAccount> = {}
    for (const [role, { person, isAdmin }] of Object.entries(ROLES)) {
      if (emails.some(email => email.includes(`+baseline-${role}-`))) continue
      made[role] = await createAccount(context, 'baseline', role, person, {
        isAdmin
      })
    }
    return made
  })
  return { world: 'baseline', nonce, accounts, ids: {} }
}
