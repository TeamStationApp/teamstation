import type { Insertable, InsertResult, Kysely } from 'kysely'

import { asUserId, gumboOfUserId, userIdOfGumbo } from '../common/userId'
import type { Database, UsersTable } from '../server/db/database'

type FixtureUser = Omit<Insertable<UsersTable>, 'id'> & {
  id: number | string
  /** The account's own address: verified, and its primary. */
  email?: string | null
  /** The address row's id, where a test refers to it. */
  emailId?: string
}

/** Convert a historical fixture label, or validate an account returned by the API. */
export const fixtureUserId = (id: number | string): string =>
  typeof id === 'number' ? userIdOfGumbo(id) : asUserId(id)

/**
 * The address a fixture account signs in with when it is given none of its
 * own: verified, and never its primary, so a test that gives it a primary
 * address later still can.
 */
export const fixtureEmail = (userId: string): string =>
  // In hex: ids differ by case, and addresses are unique ignoring it.
  `${Buffer.from(userId).toString('hex')}@fixture.example.test`

/**
 * Seed historical fixture identities explicitly, preserving their numeric
 * scoring IDs.
 *
 * An account is only ever signed in to through its address (by a code, a
 * link or a password), so a user seeded as able to sign in
 * (`login_enabled`) is given one, as every real account has: `email`, or else
 * `fixtureEmail`, unless it has a password. `login_enabled` is written once
 * the address is there, as an account settles.
 */
export async function insertFixtureUsers(
  db: Kysely<Database>,
  values: FixtureUser | readonly FixtureUser[]
): Promise<InsertResult[]> {
  const given = Array.isArray(values) ? values : [values]
  const rows = given.map(({ email: _email, emailId: _emailId, ...row }) => ({
    ...row,
    id: fixtureUserId(row.id)
  }))
  const now = new Date()
  const addresses = given.flatMap(row => {
    const id = fixtureUserId(row.id)
    if (row.email != null)
      return [
        {
          id: row.emailId ?? `uem_fixture_${id}`,
          user_id: id,
          email: row.email,
          is_primary: true,
          verified_at: now,
          source: 'manual' as const
        }
      ]
    if (row.login_enabled !== true || row.password_hash != null) return []
    return [
      {
        id: row.emailId ?? `uem_fixture_${id}`,
        user_id: id,
        email: fixtureEmail(id),
        is_primary: false,
        verified_at: now,
        source: 'manual' as const
      }
    ]
  })
  const accounts = given
    .filter(row => row.login_enabled === true)
    .map(row => fixtureUserId(row.id))
  const insert = async (trx: Kysely<Database>): Promise<InsertResult[]> => {
    const result = await trx.insertInto('users').values(rows).execute()
    for (const row of rows) {
      const gumboId = gumboOfUserId(row.id)
      if (gumboId != null) {
        await trx
          .insertInto('gumbo_ids')
          .values({ user_id: row.id, gumbo_id: gumboId })
          .execute()
      }
    }
    if (addresses.length > 0)
      await trx.insertInto('user_emails').values(addresses).execute()
    if (accounts.length > 0)
      await trx
        .updateTable('users')
        .set({ login_enabled: true })
        .where('id', 'in', accounts)
        .execute()
    return result
  }
  return db.isTransaction
    ? await insert(db)
    : await db.transaction().execute(insert)
}
