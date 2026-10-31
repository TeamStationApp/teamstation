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
 * a copy of production cannot.
 */
export async function refuseRealAddresses(
  db: Kysely<Database>,
  mailbox: string
): Promise<void> {
  const rows = await db.selectFrom('user_emails').select('email').execute()
  const real = rows.filter(row => !isTestAddress(mailbox, row.email))
  if (real.length > 0) {
    throw new Error(
      `baseline refuses this database: ${real.length} address(es) are not test addresses`
    )
  }
}

async function findBaselineAccount(
  db: Kysely<Database>,
  mailbox: string,
  role: string
): Promise<boolean> {
  const rows = await db.selectFrom('user_emails').select('email').execute()
  return rows.some(
    row =>
      isTestAddress(mailbox, row.email) &&
      row.email.includes(`+baseline-${role}-`)
  )
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
  await refuseRealAddresses(db, mailbox)
  for (const [key, value] of Object.entries(NODE_SETTINGS)) {
    await db
      .insertInto('system_settings')
      .values({ key, value: value as never })
      .onConflict(oc => oc.column('key').doUpdateSet({ value: value as never }))
      .execute()
  }
  const context = { db, mailbox, nonce: makeNonce() }
  const accounts: Record<string, FixtureAccount> = {}
  for (const [role, { person, isAdmin }] of Object.entries(ROLES)) {
    if (await findBaselineAccount(db, mailbox, role)) continue
    accounts[role] = await createAccount(context, 'baseline', role, person, {
      isAdmin
    })
  }
  return { world: 'baseline', nonce: context.nonce, accounts, ids: {} }
}
