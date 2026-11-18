/**
 * Per-transaction caches for a publication's reads: inside `withRolesRead` on
 * a transaction, a person's roles, account and other facts the transaction
 * does not change are read at most once. It imports nothing heavy, so light
 * modules (notifications, migrations) can use it without loading the server's
 * access rules.
 */
import type { Kysely } from 'kysely'

import type { Database } from './database'

/** The transactions in `withRolesRead`, and the roles read in each. */
const rolesRead = new WeakMap<Kysely<Database>, Map<string, unknown>>()

/** The transactions in `withRolesRead`, and the accounts read in each. */
const accountsRead = new WeakMap<Kysely<Database>, Map<string, unknown>>()

/**
 * `read` of a person's account, or, inside `withRolesRead` on `db`, what it
 * gave the first time.
 */
export async function accountReadOnce<T>(
  db: Kysely<Database>,
  userId: string,
  read: () => Promise<T>
): Promise<T> {
  const accounts = accountsRead.get(db)
  if (accounts == null) return await read()
  if (!accounts.has(userId)) accounts.set(userId, await read())
  return accounts.get(userId) as T
}

/** The transactions in `withRolesRead`, and the other facts read in each. */
const factsRead = new WeakMap<Kysely<Database>, Map<string, unknown>>()

/**
 * `read`, or, inside `withRolesRead` on `db`, what it gave the first time
 * for `key`: a fact the transaction does not change, such as a team's kind,
 * a season's name or a field's hours. `key` names the table and the row.
 */
export async function readOnce<T>(
  db: Kysely<Database>,
  key: string,
  read: () => Promise<T>
): Promise<T> {
  const facts = factsRead.get(db)
  if (facts == null) return await read()
  if (!facts.has(key)) facts.set(key, await read())
  return facts.get(key) as T
}

/**
 * A league's, season's or team's name through `readOnce`, or undefined when
 * there is no such row. Every reader of a name goes through here, so its key
 * always holds the same shape: one reader cannot leave a value another
 * misreads.
 */
export async function nameOnce(
  db: Kysely<Database>,
  kind: 'league' | 'season' | 'team',
  id: string
): Promise<string | undefined> {
  return (
    await readOnce(
      db,
      `${kind}:${id}:name`,
      async () =>
        await db
          .selectFrom(
            kind === 'league'
              ? 'leagues'
              : kind === 'season'
                ? 'seasons'
                : 'teams'
          )
          .select('name')
          .where('id', '=', id)
          .executeTakeFirst()
    )
  )?.name
}

/**
 * Runs `work` with each person's roles read at most once on `db`, a
 * transaction in which nobody's roles change, such as a publication's: it
 * proposes games, which grant and take away no role, and checks the same
 * people's rights for each one. The teams, seasons, season members and
 * fields it reads through `readOnce` are read once too: proposing games
 * changes none of them. Inside another `withRolesRead` on `db`, it is that
 * one's.
 */
export async function withRolesRead<T>(
  db: Kysely<Database>,
  work: () => Promise<T>
): Promise<T> {
  // Inside another, the roles it has read stay read.
  if (rolesRead.has(db)) return await work()
  rolesRead.set(db, new Map())
  accountsRead.set(db, new Map())
  factsRead.set(db, new Map())
  try {
    return await work()
  } finally {
    rolesRead.delete(db)
    accountsRead.delete(db)
    factsRead.delete(db)
  }
}

/**
 * The roles read so far inside `withRolesRead` on `db`, by person, or
 * undefined outside one. `roleScopesForUsers` fills it.
 */
export function rolesReadIn<T>(
  db: Kysely<Database>
): Map<string, T> | undefined {
  return rolesRead.get(db) as Map<string, T> | undefined
}
